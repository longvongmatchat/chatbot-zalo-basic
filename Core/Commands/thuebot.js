import { writeFile, unlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { resolveSenderRole } from "../CommandRouter.js";

const DAY_MS = 86_400_000;
const HOUR_MS = 3_600_000;

const RENTAL_KEY = "bot:rental:expires";
const REMINDED_3D_KEY = "bot:rental:reminded:3d";
const REMINDED_1D_KEY = "bot:rental:reminded:1d";
const REMINDED_EXPIRED_KEY = "bot:rental:reminded:expired";
const PENDING_PAYMENT_KEY = "bot:rental:pending";

// Yêu cầu QR tự hết hiệu lực (không thể hủy) sau thời gian này.
const PENDING_PAYMENT_TTL_MS = 30 * 60_000; // 30 phút

// Giá: 1.000đ = 1 ngày
const PRICE_PER_DAY = 1000;

// Thông tin ngân hàng nhận thanh toán
const BANK_BIN = "970407"; // MB Bank
const BANK_ACCOUNT_NO = "2349686899";
const BANK_ACCOUNT_NAME = "NGUYEN QUANG HAI";

function getSetting(
  db,
  threadId,
  key,
  defaultValue = "",
) {
  const rows = db.query(
    `SELECT value
     FROM settings
     WHERE thread_id = ? AND key = ?`,
    [threadId, key],
  );

  return rows.length ? rows[0].value : defaultValue;
}

function setSetting(
  db,
  threadId,
  key,
  value,
) {
  db.query(
    `INSERT INTO settings (thread_id, key, value)
     VALUES (?, ?, ?)
     ON CONFLICT(thread_id, key)
     DO UPDATE SET value = excluded.value`,
    [threadId, key, String(value)],
  );
}

function formatDateTime(ms) {
  return new Intl.DateTimeFormat("vi-VN", {
    dateStyle: "short",
    timeStyle: "short",
    timeZone: "Asia/Ho_Chi_Minh",
  }).format(new Date(ms));
}

function formatRemaining(expireMs) {
  const remaining = Math.max(0, expireMs - Date.now());

  const days = Math.floor(remaining / DAY_MS);
  const hours = Math.floor(
    (remaining % DAY_MS) / HOUR_MS,
  );

  return `${days} ngày ${hours} giờ`;
}

function formatMoney(amount) {
  return amount.toLocaleString("vi-VN") + "đ";
}

/**
 * Sinh link ảnh QR VietQR động cho một khoản thanh toán.
 * Dùng template "compact2" (gọn, có logo ngân hàng + số tiền + nội dung).
 */
function buildVietQrUrl({
  amount,
  addInfo,
  accountName,
}) {
  const base = `https://img.vietqr.io/image/${BANK_BIN}-${BANK_ACCOUNT_NO}-compact2.png`;

  const params = new URLSearchParams({
    amount: String(amount),
    addInfo,
    accountName,
  });

  return `${base}?${params.toString()}`;
}

/**
 * Sinh nội dung chuyển khoản duy nhất cho một threadId,
 * dùng để đối chiếu / có thể tự động cộng hạn sau này.
 */
function buildTransferContent(threadId) {
  // Zalo threadId có thể dài, chỉ lấy phần đủ để đối chiếu,
  // bỏ ký tự không phải số/chữ để nội dung CK gọn và hợp lệ.
  const cleanId = String(threadId).replace(/[^a-zA-Z0-9]/g, "");
  return `THUEBOT ${cleanId}`;
}

async function send(
  adapter,
  threadId,
  text,
  threadType = "group",
) {
  await adapter.sendText({
    threadId,
    threadType,
    text,
  });
}

/**
 * Tải ảnh QR từ VietQR về file tạm để gửi làm attachment.
 */
async function downloadQrToTemp(imageUrl) {
  const res = await fetch(imageUrl);

  if (!res.ok) {
    throw new Error(`Tải QR thất bại: HTTP ${res.status}`);
  }

  const buffer = Buffer.from(await res.arrayBuffer());

  const filePath = join(
    tmpdir(),
    `qr-thuebot-${Date.now()}.png`,
  );

  await writeFile(filePath, buffer);

  return filePath;
}

async function sendQr(
  adapter,
  threadId,
  imageUrl,
  caption,
  threadType = "group",
) {
  // Cách 1: adapter có sẵn sendImage.
  if (typeof adapter.sendImage === "function") {
    try {
      await adapter.sendImage({
        threadId,
        threadType,
        imageUrl,
        caption,
      });

      return;
    } catch {
      // Lỗi thì thử cách tiếp theo.
    }
  }

  /*
   * Cách 2: tải QR về rồi gửi như attachment
   * (zca-js hỗ trợ attachments trong sendMessage).
   */
  try {
    const filePath = await downloadQrToTemp(imageUrl);

    try {
      await adapter.sendText({
        threadId,
        threadType,
        text: caption,
        attachments: [filePath],
      });

      return;
    } finally {
      // Dọn file tạm dù gửi thành công hay lỗi.
      unlink(filePath).catch(() => {});
    }
  } catch {
    // Lỗi thì dùng fallback cuối.
  }

  // Cách 3 (fallback cuối): gửi text kèm link ảnh QR.
  await send(
    adapter,
    threadId,
    `${caption}\n\n🔗 Ảnh QR: ${imageUrl}`,
    threadType,
  );
}

/**
 * Lưu yêu cầu thanh toán QR đang chờ cho một thread.
 * Ghi đè yêu cầu cũ nếu có (mỗi thread chỉ có 1 yêu cầu chờ tại một thời điểm).
 */
function savePendingPayment(db, threadId, payment) {
  setSetting(
    db,
    threadId,
    PENDING_PAYMENT_KEY,
    JSON.stringify(payment),
  );
}

/**
 * Đọc yêu cầu thanh toán QR đang chờ, tự bỏ qua nếu đã hết hạn TTL.
 */
function getPendingPayment(db, threadId) {
  const raw = getSetting(
    db,
    threadId,
    PENDING_PAYMENT_KEY,
    "",
  );

  if (!raw) return null;

  let payment;

  try {
    payment = JSON.parse(raw);
  } catch {
    return null;
  }

  if (
    !payment ||
    typeof payment.createdAt !== "number" ||
    Date.now() - payment.createdAt >
      PENDING_PAYMENT_TTL_MS
  ) {
    return null;
  }

  return payment;
}

function clearPendingPayment(db, threadId) {
  setSetting(
    db,
    threadId,
    PENDING_PAYMENT_KEY,
    "",
  );
}

function isOwner(config, senderId) {
  return (
    String(senderId) ===
    String(config.ownerZaloId)
  );
}

/**
 * Xóa trạng thái đã nhắc khi thời hạn được thay đổi.
 */
function resetReminderState(db, threadId) {
  setSetting(
    db,
    threadId,
    REMINDED_3D_KEY,
    "",
  );

  setSetting(
    db,
    threadId,
    REMINDED_1D_KEY,
    "",
  );

  setSetting(
    db,
    threadId,
    REMINDED_EXPIRED_KEY,
    "",
  );
}

/**
 * Chỉ nhắc một lần cho mỗi mốc của một thời hạn.
 *
 * Giá trị lưu trong reminder key chính là expireMs.
 * Khi owner gia hạn, expireMs thay đổi nên bot có thể nhắc lại.
 */
async function checkRentalReminder({
  adapter,
  threadId,
  db,
  logger,
}) {
  const expireMs =
    Number(
      getSetting(
        db,
        threadId,
        RENTAL_KEY,
        "0",
      ),
    ) || 0;

  // Box chưa từng được kích hoạt.
  if (expireMs <= 0) return;

  const now = Date.now();
  const remaining = expireMs - now;
  const reminderValue = String(expireMs);

  try {
    if (remaining <= 0) {
      const reminded = getSetting(
        db,
        threadId,
        REMINDED_EXPIRED_KEY,
        "",
      );

      if (reminded === reminderValue) return;

      await send(
        adapter,
        threadId,
        "⛔ THỜI HẠN THUÊ BOT ĐÃ KẾT THÚC\n" +
          `⏰ Hết hạn lúc: ${formatDateTime(expireMs)}\n` +
          "💳 Admin dùng .thanhtoan thuebot để gia hạn.",
      );

      setSetting(
        db,
        threadId,
        REMINDED_EXPIRED_KEY,
        reminderValue,
      );

      return;
    }

    if (remaining <= DAY_MS) {
      const reminded = getSetting(
        db,
        threadId,
        REMINDED_1D_KEY,
        "",
      );

      if (reminded === reminderValue) return;

      await send(
        adapter,
        threadId,
        "⚠️ BOT SẮP HẾT HẠN\n" +
          `⏳ Còn lại: ${formatRemaining(expireMs)}\n` +
          `⏰ Hết hạn: ${formatDateTime(expireMs)}\n` +
          "💳 Admin dùng .thanhtoan thuebot để gia hạn.",
      );

      setSetting(
        db,
        threadId,
        REMINDED_1D_KEY,
        reminderValue,
      );

      return;
    }

    if (remaining <= 3 * DAY_MS) {
      const reminded = getSetting(
        db,
        threadId,
        REMINDED_3D_KEY,
        "",
      );

      if (reminded === reminderValue) return;

      await send(
        adapter,
        threadId,
        "🔔 NHẮC GIA HẠN BOT\n" +
          `⏳ Còn lại: ${formatRemaining(expireMs)}\n` +
          `⏰ Hết hạn: ${formatDateTime(expireMs)}\n` +
          "💳 Admin dùng .thanhtoan thuebot để gia hạn.",
      );

      setSetting(
        db,
        threadId,
        REMINDED_3D_KEY,
        reminderValue,
      );
    }
  } catch (error) {
    logger?.warn?.(
      "[thuebot] Không gửi được thông báo thời hạn",
      {
        threadId,
        message: error?.message,
      },
    );
  }
}

function getRentalList(db) {
  return db.query(
    `SELECT thread_id, value
     FROM settings
     WHERE key = ?
     ORDER BY CAST(value AS INTEGER) DESC`,
    [RENTAL_KEY],
  );
}

function createRentalListText(rows) {
  const now = Date.now();

  if (!rows.length) {
    return "📋 Chưa có box nào được kích hoạt thuê bot.";
  }

  let active = 0;
  let expired = 0;

  const items = rows.map((row, index) => {
    const expireMs = Number(row.value) || 0;

    if (expireMs > now) {
      active += 1;

      return (
        `${index + 1}. ✅ ${row.thread_id}\n` +
        `   Còn: ${formatRemaining(expireMs)}\n` +
        `   Hết hạn: ${formatDateTime(expireMs)}`
      );
    }

    expired += 1;

    return (
      `${index + 1}. ❌ ${row.thread_id}\n` +
      (
        expireMs > 0
          ? `   Hết hạn: ${formatDateTime(expireMs)}`
          : "   Chưa kích hoạt"
      )
    );
  });

  return (
    "📋 DANH SÁCH BOX THUÊ BOT\n" +
    "━━━━━━━━━━━━━━━━━━━━\n" +
    `✅ Đang hoạt động: ${active}\n` +
    `❌ Hết hạn/tắt: ${expired}\n` +
    `📦 Tổng cộng: ${rows.length}\n` +
    "━━━━━━━━━━━━━━━━━━━━\n" +
    items.join("\n\n")
  );
}

export default {
  name: "thuebot",
  description: "Quản lý thời hạn sử dụng bot của nhóm",
  version: "4.0.0",
  author: "PTF",
  group: "moderation",
  role: 0,
  cooldown: 2,
  aliases: [
    "rent",
    "giahan",
  ],
  noPrefix: false,

  async run({
    adapter,
    message,
    args,
    config,
    db,
  }) {
    const threadId = message.threadId;

    if (message.type !== 1) {
      await send(
        adapter,
        threadId,
        "Lệnh này chỉ dùng trong nhóm.",
        "user",
      );

      return;
    }

    const sub = (
      args[0] || "check"
    ).toLowerCase();

    /*
     * Ai cũng được kiểm tra thời hạn của box hiện tại.
     */
    if (sub === "check") {
      const expireMs =
        Number(
          getSetting(
            db,
            threadId,
            RENTAL_KEY,
            "0",
          ),
        ) || 0;

      const now = Date.now();

      if (!expireMs) {
        await send(
          adapter,
          threadId,
          "🤖 THÔNG TIN THUÊ BOT\n" +
            "• Trạng thái: CHƯA KÍCH HOẠT\n" +
            `• Giá: ${formatMoney(PRICE_PER_DAY)} / ngày\n` +
            "• Thanh toán: .thuebot pay <số ngày>",
        );

        return;
      }

      if (expireMs <= now) {
        await send(
          adapter,
          threadId,
          "🤖 THÔNG TIN THUÊ BOT\n" +
            "• Trạng thái: ĐÃ HẾT HẠN\n" +
            `• Hết hạn lúc: ${formatDateTime(expireMs)}\n` +
            `• Giá: ${formatMoney(PRICE_PER_DAY)} / ngày\n` +
            "• Thanh toán: .thuebot pay <số ngày>",
        );

        return;
      }

      await send(
        adapter,
        threadId,
        "🤖 THÔNG TIN THUÊ BOT\n" +
          "• Trạng thái: ĐANG HOẠT ĐỘNG\n" +
          `• Còn lại: ${formatRemaining(expireMs)}\n` +
          `• Hết hạn: ${formatDateTime(expireMs)}`,
      );

      return;
    }

    /*
     * Ai cũng được yêu cầu QR thanh toán để gia hạn.
     * !thuebot pay <so_ngay>
     */
    if (sub === "pay" || sub === "thanhtoan") {
      const days = Number(args[1]);

      if (
        !Number.isInteger(days) ||
        days <= 0 ||
        days > 3650
      ) {
        await send(
          adapter,
          threadId,
          "Cú pháp: !thuebot pay <số ngày từ 1 đến 3650>\n" +
            `Giá: ${formatMoney(PRICE_PER_DAY)} / ngày`,
        );

        return;
      }

      const amount = days * PRICE_PER_DAY;
      const addInfo = buildTransferContent(threadId);

      const qrUrl = buildVietQrUrl({
        amount,
        addInfo,
        accountName: BANK_ACCOUNT_NAME,
      });

      const caption =
        "💳 THANH TOÁN THUÊ BOT\n" +
        "━━━━━━━━━━━━━━━━━━━━\n" +
        `📅 Số ngày: ${days} ngày\n` +
        `💰 Số tiền: ${formatMoney(amount)}\n` +
        `🏦 Ngân hàng: MB Bank\n` +
        `👤 Chủ TK: ${BANK_ACCOUNT_NAME}\n` +
        `🔢 Số TK: ${BANK_ACCOUNT_NO}\n` +
        `📝 Nội dung CK: ${addInfo}\n` +
        "━━━━━━━━━━━━━━━━━━━━\n" +
        "⚠️ Vui lòng chuyển đúng nội dung để được cộng hạn nhanh.\n" +
        "Sau khi chuyển khoản, gửi ảnh biên lai cho admin/owner để được kích hoạt.";

      await sendQr(
        adapter,
        threadId,
        qrUrl,
        caption,
      );

      return;
    }

    const senderId = message.data.uidFrom;
    const senderIsOwner = isOwner(
      config,
      senderId,
    );

    /*
     * Danh sách box chỉ owner được xem.
     */
    if (sub === "list") {
      if (!senderIsOwner) {
        await send(
          adapter,
          threadId,
          "⛔ Chỉ owner bot được xem danh sách box.",
        );

        return;
      }

      const rows = getRentalList(db);

      /*
       * Tránh tin nhắn quá dài.
       * Chỉ hiển thị tối đa 50 box một lần.
       */
      const visibleRows = rows.slice(0, 50);
      let listText =
        createRentalListText(visibleRows);

      if (rows.length > 50) {
        listText +=
          `\n\n⚠️ Còn ${rows.length - 50} box ` +
          "chưa được hiển thị.";
      }

      await send(
        adapter,
        threadId,
        listText,
      );

      return;
    }

    /*
     * add, set và xóa chỉ dành cho owner.
     */
    const senderRole =
      await resolveSenderRole(
        {
          adapter,
          isOwner: (uid) =>
            isOwner(config, uid),
        },
        message,
        senderId,
      );

    if (!senderIsOwner) {
      await send(
        adapter,
        threadId,
        senderRole >= 1
          ? "Chỉ owner bot được thay đổi thời hạn. Dùng .thuebot pay <số ngày> để lấy QR gia hạn."
          : "Bạn không có quyền sử dụng thao tác này.",
      );

      return;
    }

    if (
      sub === "add" ||
      sub === "set"
    ) {
      const days = Number(args[1]);

      if (
        !Number.isInteger(days) ||
        days <= 0 ||
        days > 3650
      ) {
        await send(
          adapter,
          threadId,
          `Cú pháp: !thuebot ${sub} <số ngày từ 1 đến 3650>`,
        );

        return;
      }

      const now = Date.now();

      const currentExpire =
        Number(
          getSetting(
            db,
            threadId,
            RENTAL_KEY,
            "0",
          ),
        ) || 0;

      const newExpire =
        sub === "add"
          ? Math.max(currentExpire, now) +
            days * DAY_MS
          : now + days * DAY_MS;

      setSetting(
        db,
        threadId,
        RENTAL_KEY,
        newExpire,
      );

      resetReminderState(
        db,
        threadId,
      );

      await send(
        adapter,
        threadId,
        `✅ Đã ${
          sub === "add"
            ? "cộng thêm"
            : "đặt lại"
        } ${days} ngày.\n` +
          `⏰ Hết hạn: ${formatDateTime(newExpire)}`,
      );

      return;
    }

    if (
      sub === "off" ||
      sub === "xoa"
    ) {
      setSetting(
        db,
        threadId,
        RENTAL_KEY,
        "0",
      );

      resetReminderState(
        db,
        threadId,
      );

      await send(
        adapter,
        threadId,
        "✅ Đã tắt thời hạn thuê bot của nhóm.",
      );

      return;
    }

    await send(
      adapter,
      threadId,
      "📖 CÚ PHÁP THUÊ BOT\n" +
        "• !thuebot check\n" +
        `• !thuebot pay <ngày> — lấy QR thanh toán (${formatMoney(PRICE_PER_DAY)}/ngày)\n` +
        "• !thuebot list — chỉ owner\n" +
        "• !thuebot add <ngày> — chỉ owner\n" +
        "• !thuebot set <ngày> — chỉ owner\n" +
        "• !thuebot xoa — chỉ owner",
    );
  },

  async onMessage({
    adapter,
    message,
    config,
    db,
    logger,
  }) {
    if (
      message.type !== 1 ||
      message.isSelf
    ) {
      return;
    }

    const threadId = message.threadId;

    /*
     * Kiểm tra nhắc hạn mỗi khi box có hoạt động.
     * Các reminder key ngăn gửi thông báo trùng.
     */
    await checkRentalReminder({
      adapter,
      threadId,
      db,
      logger,
    });

    const text =
      typeof message.data?.content === "string"
        ? message.data.content.trim()
        : "";

    const prefix = config.prefix || "!";

    if (!text.startsWith(prefix)) {
      return;
    }

    const command =
      text
        .slice(prefix.length)
        .trim()
        .split(/\s+/)[0]
        ?.toLowerCase() || "";

    /*
     * Luôn cho phép các lệnh kiểm tra,
     * quản lý và thanh toán.
     */
    if (
      [
        "thuebot",
        "rent",
        "giahan",
      ].includes(command)
    ) {
      return;
    }

    const senderId =
      message.data.uidFrom;

    const senderRole =
      await resolveSenderRole(
        {
          adapter,
          isOwner: (uid) =>
            isOwner(config, uid),
        },
        message,
        senderId,
      );

    /*
     * Owner và quản trị viên vẫn được phép
     * thao tác quản lý khi box hết hạn.
     */
    if (senderRole >= 1) {
      return;
    }

    const expireMs =
      Number(
        getSetting(
          db,
          threadId,
          RENTAL_KEY,
          "0",
        ),
      ) || 0;

    if (expireMs > Date.now()) {
      return;
    }

    try {
      await adapter.deleteMessage(message);
    } catch (error) {
      if (
        error?.code !==
        "FEATURE_UNAVAILABLE"
      ) {
        logger?.warn?.(
          "[thuebot] Không xóa được tin nhắn",
          {
            message: error?.message,
          },
        );
      }
    }

    await send(
      adapter,
      threadId,
      "⚠️ Nhóm chưa thuê bot hoặc đã hết hạn.\n" +
        `💳 Dùng .thuebot pay <số ngày> để lấy QR gia hạn (${formatMoney(PRICE_PER_DAY)}/ngày).`,
    );
  },
};
