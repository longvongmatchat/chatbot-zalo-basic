import { writeFile, unlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";

import { resolveSenderRole } from "../CommandRouter.js";

const BANK_ID = process.env.RENTAL_BANK_ID || "TCB";
const BANK_NUMBER = process.env.RENTAL_BANK_NUMBER || "2349686899";
const ACCOUNT_HOLDER = process.env.RENTAL_ACCOUNT_HOLDER || "NGUYEN QUANG HAI";
const PAYMENT_API_URL = process.env.PAYMENT_API_URL;
const DAYS_TO_ADD = Number(process.env.RENTAL_DAYS_PER_PAYMENT || 30);
const CHECK_INTERVAL_MS = 15_000;
const TIMEOUT_MS = 10 * 60_000;
const pendingChecks = new Map();

function getSetting(db, threadId, key, defaultValue = "") {
  const rows = db.query("SELECT value FROM settings WHERE thread_id = ? AND key = ?", [threadId, key]);
  return rows.length ? rows[0].value : defaultValue;
}

function setSetting(db, threadId, key, value) {
  db.query(
    `INSERT INTO settings (thread_id, key, value) VALUES (?, ?, ?)
     ON CONFLICT(thread_id, key) DO UPDATE SET value = excluded.value`,
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

function paymentCode(threadId) {
  const suffix = String(threadId).replace(/[^a-z0-9]/gi, "").slice(-8).toUpperCase();
  return `THUEBOT ${suffix || "ZALO"}`;
}

function normalizeText(value) {
  return String(value ?? "").normalize("NFD").replace(/[\u0300-\u036f]/g, "").toUpperCase();
}

function transactionId(tx) {
  return String(tx.id ?? tx.transactionId ?? tx.transId ?? tx.reference ?? tx.time ?? "");
}

function transactionNote(tx) {
  return tx.description ?? tx.content ?? tx.remark ?? tx.note ?? tx.transactionContent ?? "";
}

function isIncoming(tx) {
  const amount = Number(tx.amount ?? tx.creditAmount ?? tx.credit ?? tx.money ?? 0);
  const type = normalizeText(tx.type ?? tx.direction ?? tx.transactionType ?? "");
  return amount > 0 && !type.includes("DEBIT") && !type.includes("OUT");
}

function extractTransactions(payload) {
  if (Array.isArray(payload)) return payload;
  for (const value of [payload?.data, payload?.transactions, payload?.history, payload?.data?.transactions]) {
    if (Array.isArray(value)) return value;
  }
  return [];
}

async function fetchTransactions() {
  if (!PAYMENT_API_URL) throw new Error("Thiếu biến môi trường PAYMENT_API_URL");
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 10_000);
  try {
    const response = await fetch(PAYMENT_API_URL, {
      signal: controller.signal,
      headers: { accept: "application/json" },
    });
    if (!response.ok) throw new Error(`Payment API trả về HTTP ${response.status}`);
    return extractTransactions(await response.json());
  } finally {
    clearTimeout(timeout);
  }
}

/**
 * Tải ảnh QR VietQR về thành file PNG tạm trên đĩa.
 * adapter.sendImage() của zca-mt cần một đường dẫn file cục bộ
 * (imagePath), không nhận URL trực tiếp — nên phải tải về trước.
 */
async function downloadQrImage(qrUrl) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 15_000);

  try {
    const response = await fetch(qrUrl, {
      signal: controller.signal,
      headers: { accept: "image/png,image/*" },
    });

    if (!response.ok) {
      throw new Error(`Không tải được QR: HTTP ${response.status}`);
    }

    const contentType = response.headers.get("content-type") || "";
    if (!contentType.startsWith("image/")) {
      throw new Error("VietQR không trả về dữ liệu ảnh");
    }

    const imageBuffer = Buffer.from(await response.arrayBuffer());
    if (!imageBuffer.length) {
      throw new Error("Ảnh QR trống");
    }

    const imagePath = join(tmpdir(), `thanhtoan-${randomUUID()}.png`);
    await writeFile(imagePath, imageBuffer);

    return imagePath;
  } finally {
    clearTimeout(timeout);
  }
}

/**
 * Tải QR về rồi gửi bằng adapter.sendImage (imagePath), không bao giờ
 * gửi URL QR vào tin nhắn text.
 */
async function sendQrImage({ adapter, threadId, qrUrl, text }) {
  const imagePath = await downloadQrImage(qrUrl);

  try {
    await adapter.sendImage({
      threadId,
      threadType: "group",
      imagePath,
      message: { text },
    });
  } finally {
    // Chờ gửi xong mới xóa file QR tạm.
    await unlink(imagePath).catch(() => {});
  }
}

async function startAutoCheck({ threadId, adapter, db, code, logger }) {
  if (pendingChecks.has(threadId)) return false;

  // Chụp toàn bộ ID hiện có làm mốc, tránh nhận nhầm giao dịch cũ.
  const baseline = new Set((await fetchTransactions()).map(transactionId).filter(Boolean));
  const startedAt = Date.now();
  const state = { cancelled: false, timer: null };
  pendingChecks.set(threadId, state);

  const finish = () => {
    state.cancelled = true;
    if (state.timer) clearTimeout(state.timer);
    pendingChecks.delete(threadId);
  };

  const poll = async () => {
    if (state.cancelled) return;
    if (Date.now() - startedAt >= TIMEOUT_MS) {
      finish();
      await adapter.sendText({
        threadId,
        threadType: "group",
        text: "⏱️ Đã hết 10 phút chờ thanh toán. Nếu bạn đã chuyển khoản, hãy chạy lại lệnh để hệ thống kiểm tra lại.",
      });
      return;
    }

    try {
      const transactions = await fetchTransactions();
      const normalizedCode = normalizeText(code).replace(/\s+/g, " ");
      const matched = transactions.find((tx) => {
        const id = transactionId(tx);
        const note = normalizeText(transactionNote(tx)).replace(/\s+/g, " ");
        return id && !baseline.has(id) && isIncoming(tx) && note.includes(normalizedCode);
      });

      if (matched) {
        const txId = transactionId(matched);
        const processedKey = `bot:payment:processed:${txId}`;
        if (getSetting(db, "__global__", processedKey, "") === "1") {
          baseline.add(txId);
        } else {
          // Đánh dấu trước khi cộng ngày để cùng một giao dịch không được dùng cho nhiều nhóm.
          setSetting(db, "__global__", processedKey, "1");
          const now = Date.now();
          const current = Number(getSetting(db, threadId, "bot:rental:expires", "0")) || 0;
          const newExpire = Math.max(current, now) + DAYS_TO_ADD * 86_400_000;
          setSetting(db, threadId, "bot:rental:expires", newExpire);
          finish();
          await adapter.sendText({
            threadId,
            threadType: "group",
            text: `✅ Đã nhận thanh toán. Thời hạn thuê bot được cộng thêm ${DAYS_TO_ADD} ngày.\n⏰ Hết hạn: ${formatDateTime(newExpire)}`,
          });
          return;
        }
      }
    } catch (error) {
      logger?.warn?.("[thanhtoan] Không kiểm tra được giao dịch", { message: error?.message });
    }

    state.timer = setTimeout(poll, CHECK_INTERVAL_MS);
    state.timer.unref?.();
  };

  state.timer = setTimeout(poll, CHECK_INTERVAL_MS);
  state.timer.unref?.();
  return true;
}

export default {
  name: "thanhtoan",
  description: "Thanh toán thuê bot qua VietQR và tự động cộng ngày",
  version: "2.2.0",
  author: "PTF",
  group: "moderation",
  role: 0,
  cooldown: 10,
  aliases: ["transfer"],
  noPrefix: false,

  async run({ adapter, message, args, config, db, logger }) {
    const threadId = message.threadId;
    if (message.type !== 1) {
      await adapter.sendText({ threadId, threadType: "user", text: "🏠 Lệnh thanh toán thuê bot chỉ có thể sử dụng trong nhóm." });
      return;
    }
    if ((args[0] || "").toLowerCase() !== "thuebot") {
      await adapter.sendText({ threadId, threadType: "group", text: "Cú pháp: !thanhtoan thuebot\nVí dụ: !thanhtoan thuebot" });
      return;
    }

    const senderRole = await resolveSenderRole(
      { adapter, isOwner: (uid) => String(uid) === String(config.ownerZaloId) },
      message,
      message.data.uidFrom,
    );
    if (senderRole < 1) {
      await adapter.sendText({ threadId, threadType: "group", text: "Chỉ quản trị viên nhóm hoặc owner được tạo yêu cầu thanh toán." });
      return;
    }
    if (!PAYMENT_API_URL) {
      await adapter.sendText({ threadId, threadType: "group", text: "⚠️ Owner chưa cấu hình PAYMENT_API_URL cho bot." });
      return;
    }
    if (pendingChecks.has(threadId)) {
      await adapter.sendText({ threadId, threadType: "group", text: "⏳ Nhóm này đang có một yêu cầu thanh toán chờ xử lý." });
      return;
    }

    const code = paymentCode(threadId);
    const qrUrl = `https://img.vietqr.io/image/${encodeURIComponent(BANK_ID)}-${encodeURIComponent(BANK_NUMBER)}-compact2.png?addInfo=${encodeURIComponent(code)}&accountName=${encodeURIComponent(ACCOUNT_HOLDER)}`;

    try {
      await startAutoCheck({ threadId, adapter, db, code, logger });
    } catch (error) {
      logger?.error?.("[thanhtoan] Không khởi tạo được kiểm tra", { message: error?.message });
      await adapter.sendText({ threadId, threadType: "group", text: "❌ Chưa kết nối được hệ thống giao dịch. Vui lòng thử lại sau." });
      return;
    }

    const text =
      `💳 THANH TOÁN THUÊ BOT\n━━━━━━━━━━━━━━━━━━━━\n` +
      `🏦 Ngân hàng: ${BANK_ID}\n🔢 Số tài khoản: ${BANK_NUMBER}\n` +
      `👤 Chủ tài khoản: ${ACCOUNT_HOLDER}\n📝 Nội dung bắt buộc: ${code}\n` +
      `━━━━━━━━━━━━━━━━━━━━\n⏳ Theo dõi trong 10 phút; thanh toán hợp lệ sẽ cộng ${DAYS_TO_ADD} ngày.`;

    try {
      await sendQrImage({ adapter, threadId, qrUrl, text });
    } catch (error) {
      logger?.error?.("[thanhtoan] Không gửi được ảnh QR", { message: error?.message });

      // Hủy tiến trình chờ nếu QR không gửi được, để người dùng chạy lại lệnh.
      const pending = pendingChecks.get(threadId);
      if (pending) {
        pending.cancelled = true;
        if (pending.timer) clearTimeout(pending.timer);
        pendingChecks.delete(threadId);
      }

      await adapter.sendText({
        threadId,
        threadType: "group",
        text: "❌ Không thể tạo hoặc gửi ảnh QR. Vui lòng thử lại sau.",
      });
    }
  },
};
