
const express = require('express');
const crypto = require('crypto');
const cors = require('cors');

const app = express();

// ==================================
// 1. 基本設定
// ==================================

app.set('trust proxy', 1);

const PORT = process.env.PORT || 10000;

const SHOPEE_TIMEOUT = 15000;
const COUPANG_TIMEOUT = 15000;

// 蝦皮 API 憑證
const APP_ID = process.env.APP_ID;
const APP_SECRET = process.env.APP_SECRET;

// 酷澎 API 憑證
const COUPANG_ACCESS_KEY = process.env.COUPANG_ACCESS_KEY;
const COUPANG_SECRET_KEY = process.env.COUPANG_SECRET_KEY;

// 蝦皮憑證為必要設定
if (!APP_ID || !APP_SECRET) {
    console.error('[CONFIG ERROR] 缺少 APP_ID 或 APP_SECRET');
    process.exit(1);
}

// ==================================
// 2. CORS 與 JSON
// ==================================

app.use(cors({
    origin: 'https://shopiq33.github.io',
    methods: ['GET', 'POST', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization']
}));

app.use(express.json({ limit: '100kb' }));

// ==================================
// 3. 請求診斷紀錄
// ==================================

app.use((req, res, next) => {
    const requestId = crypto.randomUUID();
    const startTime = Date.now();

    req.requestId = requestId;

    console.log(
        `[REQUEST START] id=${requestId}` +
        ` time=${new Date().toISOString()}` +
        ` method=${req.method}` +
        ` path=${req.path}` +
        ` ip=${req.ip}`
    );

    res.setHeader('X-Request-ID', requestId);

    res.on('finish', () => {
        console.log(
            `[REQUEST END] id=${requestId}` +
            ` status=${res.statusCode}` +
            ` duration=${Date.now() - startTime}ms`
        );
    });

    res.on('close', () => {
        if (!res.writableEnded) {
            console.warn(
                `[REQUEST ABORTED] id=${requestId}` +
                ` path=${req.path}`
            );
        }
    });

    next();
});

// ==================================
// 4. 健康檢查
// ==================================

app.get('/', (req, res) => {
    res.status(200).json({
        status: 'ok',
        message: 'Affiliate Backend is running!'
    });
});

app.get('/health', (req, res) => {
    res.status(200).json({
        status: 'ok',
        uptime: Math.floor(process.uptime()),
        memory: process.memoryUsage().rss
    });
});

// ==================================
// 5. 系統資源監控
// ==================================

setInterval(() => {
    const memory = process.memoryUsage();
    const usage = process.cpuUsage();

    console.log(
        `[SYSTEM]` +
        ` uptime=${Math.floor(process.uptime())}s` +
        ` rss=${Math.round(memory.rss / 1024 / 1024)}MB` +
        ` heap=${Math.round(memory.heapUsed / 1024 / 1024)}MB` +
        ` cpu_user=${usage.user}` +
        ` cpu_system=${usage.system}`
    );
}, 60000).unref();

// ==================================
// 6. 蝦皮推廣連結轉換
// 原功能保留
// ==================================

app.post('/convert', async (req, res) => {
    const requestId = req.requestId;

    try {
        const { url } = req.body || {};

        if (
            !url ||
            typeof url !== 'string' ||
            !url.trim()
        ) {
            return res.status(400).json({
                success: false,
                error_code: 'INVALID_URL',
                error: '請提供有效的網址',
                request_id: requestId
            });
        }

        const originUrl = url.trim();

        const payload = JSON.stringify({
            query: `mutation {
                generateShortLink(
                    input: {
                        originUrl: ${JSON.stringify(originUrl)}
                    }
                ) {
                    shortLink
                }
            }`
        });

        const timestamp = Math.floor(Date.now() / 1000);

        const factor =
            `${APP_ID}${timestamp}${payload}${APP_SECRET}`;

        const signature = crypto
            .createHash('sha256')
            .update(factor)
            .digest('hex');

        console.log(
            `[SHOPEE REQUEST] id=${requestId} 開始呼叫蝦皮 API`
        );

        const controller = new AbortController();

        const timeout = setTimeout(() => {
            controller.abort();
        }, SHOPEE_TIMEOUT);

        let shopeeRes;

        try {
            shopeeRes = await fetch(
                'https://open-api.affiliate.shopee.tw/graphql',
                {
                    method: 'POST',
                    headers: {
                        'Content-Type': 'application/json',
                        'Authorization':
                            `SHA256 Credential=${APP_ID}, Timestamp=${timestamp}, Signature=${signature}`
                    },
                    body: payload,
                    signal: controller.signal
                }
            );
        } finally {
            clearTimeout(timeout);
        }

        const responseText = await shopeeRes.text();

        let data;

        try {
            data = JSON.parse(responseText);
        } catch {
            console.error(
                `[SHOPEE ERROR] id=${requestId} 回傳非 JSON`
            );

            return res.status(502).json({
                success: false,
                error_code: 'SHOPEE_INVALID_RESPONSE',
                error: '蝦皮 API 回傳格式異常',
                request_id: requestId
            });
        }

        if (!shopeeRes.ok || data.errors) {
            console.error(
                `[SHOPEE ERROR] id=${requestId}` +
                ` status=${shopeeRes.status}` +
                ` errors=${JSON.stringify(data.errors || data)}`
            );

            return res.status(502).json({
                success: false,
                error_code: 'SHOPEE_API_ERROR',
                error: '蝦皮 API 轉換失敗',
                request_id: requestId,
                upstream_status: shopeeRes.status
            });
        }

        const shortLink =
            data.data?.generateShortLink?.shortLink;

        if (!shortLink) {
            console.error(
                `[SHOPEE ERROR] id=${requestId} 沒有取得短網址`
            );

            return res.status(502).json({
                success: false,
                error_code: 'SHOPEE_EMPTY_RESULT',
                error: '蝦皮沒有回傳短網址',
                request_id: requestId
            });
        }

        console.log(
            `[SHOPEE SUCCESS] id=${requestId} 轉換成功`
        );

        return res.status(200).json({
            success: true,
            affiliate_url: shortLink,
            request_id: requestId
        });

    } catch (err) {
        console.error(
            `[SHOPEE ERROR] id=${requestId}`,
            err.name,
            err.message
        );

        if (err.name === 'AbortError') {
            return res.status(504).json({
                success: false,
                error_code: 'SHOPEE_TIMEOUT',
                error: '蝦皮 API 等待逾時，請稍後重試',
                request_id: requestId
            });
        }

        return res.status(500).json({
            success: false,
            error_code: 'BACKEND_ERROR',
            error: '後端發生內部錯誤',
            request_id: requestId
        });
    }
});

// ==================================
// 7. 酷澎 Partners 推廣連結轉換
// 短網址由前台協助展開
// ==================================

app.post('/coupang/convert', async (req, res) => {
    const requestId = req.requestId;

    try {
        if (!COUPANG_ACCESS_KEY || !COUPANG_SECRET_KEY) {
            console.error(
                `[COUPANG CONFIG ERROR] id=${requestId} 缺少酷澎 API 憑證`
            );

            return res.status(503).json({
                success: false,
                error_code: 'COUPANG_CONFIG_MISSING',
                error: '酷澎 API 尚未完成設定',
                request_id: requestId
            });
        }

        const { url } = req.body || {};

        if (
            !url ||
            typeof url !== 'string' ||
            !url.trim()
        ) {
            return res.status(400).json({
                success: false,
                error_code: 'INVALID_URL',
                error: '請提供有效的酷澎商品網址',
                request_id: requestId
            });
        }

        // 僅接受前台已展開的酷澎台灣商品網址
        const originUrl = url.trim();

        let parsedUrl;

        try {
            parsedUrl = new URL(originUrl);
        } catch {
            return res.status(400).json({
                success: false,
                error_code: 'INVALID_URL',
                error: '商品網址格式不正確',
                request_id: requestId
            });
        }

        const allowedDomains = [
            'www.tw.coupang.com',
            'tw.coupang.com'
        ];

        if (
            parsedUrl.protocol !== 'https:' ||
            !allowedDomains.includes(parsedUrl.hostname.toLowerCase()) ||
            parsedUrl.username ||
            parsedUrl.password
        ) {
            console.warn(
                `[COUPANG URL REJECTED] id=${requestId}` +
                ` host=${parsedUrl.hostname}`
            );

            return res.status(400).json({
                success: false,
                error_code: 'INVALID_COUPANG_PRODUCT_URL',
                error: '請先開啟酷澎短網址，並貼上已展開的台灣商品網址',
                request_id: requestId
            });
        }

        console.log(
            `[COUPANG URL VERIFIED] id=${requestId} 商品網址驗證成功`
        );

        // Coupang Partners Deep Link API
        const method = 'POST';

        const apiPath =
            '/v2/providers/affiliate_open_api/apis/openapi/v1/deeplink';

        const apiUrl =
            `https://api-gateway.tw.coupang.com${apiPath}`;

        // HMAC 日期格式：YYMMDDTHHmmssZ
        const signedDate = new Date()
            .toISOString()
            .replace(/[-:]/g, '')
            .replace(/\.\d{3}/, '')
            .slice(2);

        // HMAC 簽章
        const message =
            signedDate + method + apiPath;

        const signature = crypto
            .createHmac('sha256', COUPANG_SECRET_KEY)
            .update(message)
            .digest('hex');

        const authorization =
            `CEA algorithm=HmacSHA256, access-key=${COUPANG_ACCESS_KEY}, signed-date=${signedDate}, signature=${signature}`;

        const payload = JSON.stringify({
            coupangUrls: [originUrl]
        });

        console.log(
            `[COUPANG REQUEST] id=${requestId} 開始呼叫酷澎 API`
        );

        const controller = new AbortController();

        const timeout = setTimeout(() => {
            controller.abort();
        }, COUPANG_TIMEOUT);

        let coupangRes;

        try {
            coupangRes = await fetch(apiUrl, {
                method,
                headers: {
                    'Content-Type': 'application/json;charset=UTF-8',
                    'Authorization': authorization
                },
                body: payload,
                signal: controller.signal
            });
        } finally {
            clearTimeout(timeout);
        }

        const responseText = await coupangRes.text();

        let data;

        try {
            data = JSON.parse(responseText);
        } catch {
            console.error(
                `[COUPANG ERROR] id=${requestId} 回傳非 JSON`
            );

            return res.status(502).json({
                success: false,
                error_code: 'COUPANG_INVALID_RESPONSE',
                error: '酷澎 API 回傳格式異常',
                request_id: requestId
            });
        }

        if (
            !coupangRes.ok ||
            data.code === 'ERROR' ||
            (data.rCode && data.rCode !== '0')
        ) {
            console.error(
                `[COUPANG ERROR] id=${requestId}` +
                ` status=${coupangRes.status}` +
                ` response=${JSON.stringify(data)}`
            );

            return res.status(502).json({
                success: false,
                error_code: 'COUPANG_API_ERROR',
                error: data.message || data.rMessage || '酷澎 API 轉換失敗',
                request_id: requestId,
                upstream_status: coupangRes.status
            });
        }

        const result = data.data?.[0];

        const shortLink =
            result?.shortenUrl ||
            result?.shorten_url;

        if (!shortLink) {
            console.error(
                `[COUPANG ERROR] id=${requestId} 沒有取得推廣連結`
            );

            return res.status(502).json({
                success: false,
                error_code: 'COUPANG_EMPTY_RESULT',
                error: '酷澎沒有回傳推廣連結',
                request_id: requestId
            });
        }

        console.log(
            `[COUPANG SUCCESS] id=${requestId} 轉換成功`
        );

        return res.status(200).json({
            success: true,
            affiliate_url: shortLink,
            request_id: requestId
        });

    } catch (err) {
        console.error(
            `[COUPANG ERROR] id=${requestId}`,
            err.name,
            err.message
        );

        if (err.name === 'AbortError') {
            return res.status(504).json({
                success: false,
                error_code: 'COUPANG_TIMEOUT',
                error: '酷澎 API 等待逾時，請稍後重試',
                request_id: requestId
            });
        }

        return res.status(500).json({
            success: false,
            error_code: 'COUPANG_BACKEND_ERROR',
            error: '酷澎轉換發生內部錯誤',
            request_id: requestId
        });
    }
});

// ==================================
// 8. 404 處理
// ==================================

app.use((req, res) => {
    res.status(404).json({
        success: false,
        error_code: 'NOT_FOUND',
        error: '找不到此 API 路徑',
        path: req.path
    });
});

// ==================================
// 9. JSON 解析錯誤處理
// ==================================

app.use((err, req, res, next) => {
    console.error(
        '[EXPRESS ERROR]',
        err.message
    );

    if (res.headersSent) {
        return next(err);
    }

    res.status(err.status || 500).json({
        success: false,
        error_code: 'REQUEST_ERROR',
        error: '請求格式錯誤或伺服器處理失敗',
        request_id: req.requestId
    });
});

// ==================================
// 10. 啟動伺服器
// ==================================

const server = app.listen(PORT, '0.0.0.0', () => {
    console.log('================================');
    console.log('Affiliate Backend 啟動成功');
    console.log(`Port: ${PORT}`);
    console.log(`APP_ID: ${APP_ID ? '已設定' : '未設定'}`);
    console.log(`APP_SECRET: ${APP_SECRET ? '已設定' : '未設定'}`);
    console.log(`COUPANG_ACCESS_KEY: ${COUPANG_ACCESS_KEY ? '已設定' : '未設定'}`);
    console.log(`COUPANG_SECRET_KEY: ${COUPANG_SECRET_KEY ? '已設定' : '未設定'}`);
    console.log('Shopee API：已啟用');
    console.log('Coupang Partners API：已啟用');
    console.log('Coupang 短網址：由前台協助展開');
    console.log('診斷監控：已啟用');
    console.log('================================');
});

server.on('error', (err) => {
    console.error('[SERVER ERROR]', err);
});

process.on('unhandledRejection', (reason) => {
    console.error('[UNHANDLED REJECTION]', reason);
});

process.on('uncaughtException', (err) => {
    console.error('[UNCAUGHT EXCEPTION]', err);
    process.exit(1);
});
