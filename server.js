
const express = require('express');
const crypto = require('crypto');
const cors = require('cors');

const app = express();

app.set('trust proxy', 1);

const PORT = process.env.PORT || 10000;

const SHOPEE_TIMEOUT = 15000;
const COUPANG_TIMEOUT = 15000;
const COUPANG_RESOLVE_TIMEOUT = 12000;
const MAX_REDIRECTS = 8;

const APP_ID = process.env.APP_ID;
const APP_SECRET = process.env.APP_SECRET;

const COUPANG_ACCESS_KEY = process.env.COUPANG_ACCESS_KEY;
const COUPANG_SECRET_KEY = process.env.COUPANG_SECRET_KEY;

if (!APP_ID || !APP_SECRET) {
    console.error('[CONFIG ERROR] 缺少 APP_ID 或 APP_SECRET');
    process.exit(1);
}

// ==================================
// CORS
// ==================================

app.use(cors({
    origin: 'https://shopiq33.github.io',
    methods: ['GET', 'POST', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization']
}));

app.use(express.json({ limit: '100kb' }));

// ==================================
// 請求診斷
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
            console.warn(`[REQUEST ABORTED] id=${requestId}`);
        }
    });

    next();
});

// ==================================
// 健康檢查
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

setInterval(() => {
    const memory = process.memoryUsage();
    const usage = process.cpuUsage();

    console.log(
        `[SYSTEM] uptime=${Math.floor(process.uptime())}s` +
        ` rss=${Math.round(memory.rss / 1024 / 1024)}MB` +
        ` heap=${Math.round(memory.heapUsed / 1024 / 1024)}MB` +
        ` cpu_user=${usage.user}` +
        ` cpu_system=${usage.system}`
    );
}, 60000).unref();

// ==================================
// 酷澎網域設定
// ==================================

const COUPANG_SHORT_HOSTS = [
    'coupa.ng',
    'www.coupa.ng',
    'link.tw.coupang.com'
];

const COUPANG_REDIRECT_HOSTS = [
    'coupa.ng',
    'www.coupa.ng',
    'link.tw.coupang.com',
    'coupang.onelink.me'
];

const COUPANG_PRODUCT_HOSTS = [
    'www.tw.coupang.com',
    'tw.coupang.com'
];

function parseSafeUrl(value) {
    try {
        const parsed = new URL(value);

        if (
            parsed.protocol !== 'https:' ||
            parsed.username ||
            parsed.password ||
            parsed.port
        ) {
            return null;
        }

        return parsed;
    } catch {
        return null;
    }
}

function isCoupangProductUrl(value) {
    const parsed = parseSafeUrl(value);

    return !!parsed &&
        COUPANG_PRODUCT_HOSTS.includes(
            parsed.hostname.toLowerCase()
        ) &&
        parsed.pathname.startsWith('/products/');
}

function isCoupangInputUrl(value) {
    const parsed = parseSafeUrl(value);

    if (!parsed) return false;

    const host = parsed.hostname.toLowerCase();

    return (
        COUPANG_SHORT_HOSTS.includes(host) ||
        COUPANG_PRODUCT_HOSTS.includes(host)
    );
}

// ==================================
// re2 網址直接解析
// ==================================

// link.tw.coupang.com/re2 網址通常已包含商品識別碼。
// 優先使用 pageKey，其次使用 deep_link_value 裡的 pId。

function resolveCoupangRe2Url(inputUrl, requestId) {
    const parsed = parseSafeUrl(inputUrl);

    if (!parsed) return null;

    if (
        parsed.hostname.toLowerCase() !==
        'link.tw.coupang.com'
    ) {
        return null;
    }

    if (!parsed.pathname.startsWith('/re2/')) {
        return null;
    }

    const params = parsed.searchParams;

    let pageKey = params.get('pageKey');

    // 如果沒有 pageKey，嘗試從 deep_link_value 取 pId。
    if (!pageKey) {
        const deepLinkValue = params.get('deep_link_value');

        if (deepLinkValue) {
            try {
                const deepLink = new URL(deepLinkValue);

                pageKey = deepLink.searchParams.get('pId');
            } catch {
                // 不採用無法解析的 deep link
            }
        }
    }

    const itemId = params.get('itemId');
    const vendorItemId = params.get('vendorItemId');

    // 商品識別碼只接受數字，避免拼接不安全內容。
    if (
        !pageKey ||
        !/^\d+$/.test(pageKey)
    ) {
        console.warn(
            `[COUPANG RE2] id=${requestId} 找不到有效 pageKey`
        );

        return null;
    }

    if (
        itemId &&
        !/^\d+$/.test(itemId)
    ) {
        return null;
    }

    if (
        vendorItemId &&
        !/^\d+$/.test(vendorItemId)
    ) {
        return null;
    }

    // 組成酷澎台灣商品頁。
    const productUrl = new URL(
        `/products/${pageKey}`,
        'https://www.tw.coupang.com'
    );

    if (itemId) {
        productUrl.searchParams.set('itemId', itemId);
    }

    if (vendorItemId) {
        productUrl.searchParams.set(
            'vendorItemId',
            vendorItemId
        );
    }

    console.log(
        `[COUPANG RE2 SUCCESS] id=${requestId}` +
        ` pageKey=${pageKey}` +
        ` itemId=${itemId || 'none'}`
    );

    return productUrl.toString();
}

// ==================================
// 酷澎短網址自動解析
// ==================================

async function resolveCoupangUrl(inputUrl, requestId) {

    // 第一優先：解析 re2 網址本身，不必連線展開。
    const directUrl = resolveCoupangRe2Url(
        inputUrl,
        requestId
    );

    if (directUrl) {
        return directUrl;
    }

    let currentUrl = inputUrl;

    const visited = new Set();
    const startedAt = Date.now();

    const allowedHosts = [
        ...COUPANG_REDIRECT_HOSTS,
        ...COUPANG_PRODUCT_HOSTS
    ];

    for (let i = 0; i <= MAX_REDIRECTS; i++) {

        if (
            Date.now() - startedAt >
            COUPANG_RESOLVE_TIMEOUT
        ) {
            throw Object.assign(
                new Error('酷澎短網址解析逾時'),
                { code: 'COUPANG_RESOLVE_TIMEOUT' }
            );
        }

        const parsed = parseSafeUrl(currentUrl);

        if (!parsed) {
            throw Object.assign(
                new Error('網址格式不安全'),
                { code: 'COUPANG_INVALID_REDIRECT' }
            );
        }

        const hostname = parsed.hostname.toLowerCase();

        if (!allowedHosts.includes(hostname)) {
            throw Object.assign(
                new Error('跳轉至不支援的網域'),
                { code: 'COUPANG_INVALID_REDIRECT' }
            );
        }

        // 遇到 re2 時再次嘗試直接提取商品資訊。
        const directRe2 = resolveCoupangRe2Url(
            parsed.toString(),
            requestId
        );

        if (directRe2) {
            return directRe2;
        }

        if (COUPANG_PRODUCT_HOSTS.includes(hostname)) {
            console.log(
                `[COUPANG RESOLVE SUCCESS] id=${requestId}` +
                ` host=${hostname}`
            );

            return parsed.toString();
        }

        if (visited.has(parsed.toString())) {
            throw Object.assign(
                new Error('偵測到重複跳轉'),
                { code: 'COUPANG_REDIRECT_LOOP' }
            );
        }

        visited.add(parsed.toString());

        console.log(
            `[COUPANG RESOLVE] id=${requestId}` +
            ` step=${i + 1}` +
            ` host=${hostname}`
        );

        const controller = new AbortController();

        const remaining = Math.max(
            1000,
            COUPANG_RESOLVE_TIMEOUT -
            (Date.now() - startedAt)
        );

        const timeout = setTimeout(
            () => controller.abort(),
            Math.min(remaining, 6000)
        );

        let response;

        try {
            response = await fetch(parsed.toString(), {
                method: 'GET',
                redirect: 'manual',
                headers: {
                    'User-Agent':
                        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) ' +
                        'AppleWebKit/537.36 (KHTML, like Gecko) ' +
                        'Chrome/131.0.0.0 Safari/537.36',

                    'Accept':
                        'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',

                    'Accept-Language':
                        'zh-TW,zh;q=0.9,en;q=0.8',

                    'Cache-Control': 'no-cache'
                },
                signal: controller.signal
            });

        } catch (err) {

            if (err.name === 'AbortError') {
                throw Object.assign(
                    new Error('酷澎短網址解析逾時'),
                    { code: 'COUPANG_RESOLVE_TIMEOUT' }
                );
            }

            throw Object.assign(
                new Error('無法連接酷澎短網址'),
                { code: 'COUPANG_RESOLVE_CONNECTION_ERROR' }
            );

        } finally {
            clearTimeout(timeout);
        }

        if (response.status === 403) {
            console.warn(
                `[COUPANG RESOLVE BLOCKED] id=${requestId} HTTP 403`
            );

            throw Object.assign(
                new Error('酷澎拒絕伺服器解析此短網址'),
                { code: 'COUPANG_SHORT_RESOLVE_BLOCKED' }
            );
        }

        if ([301, 302, 303, 307, 308].includes(response.status)) {

            const location = response.headers.get('location');

            if (!location) {
                throw Object.assign(
                    new Error('跳轉回應缺少 Location'),
                    { code: 'COUPANG_INVALID_REDIRECT' }
                );
            }

            const nextUrl = new URL(location, parsed);

            if (
                nextUrl.protocol !== 'https:' ||
                !allowedHosts.includes(
                    nextUrl.hostname.toLowerCase()
                ) ||
                nextUrl.username ||
                nextUrl.password ||
                nextUrl.port
            ) {
                throw Object.assign(
                    new Error('跳轉網址不在允許的酷澎網域'),
                    { code: 'COUPANG_INVALID_REDIRECT' }
                );
            }

            currentUrl = nextUrl.toString();
            continue;
        }

        if (!response.ok) {
            throw Object.assign(
                new Error(`短網址回應 HTTP ${response.status}`),
                { code: 'COUPANG_RESOLVE_HTTP_ERROR' }
            );
        }

        const contentType =
            response.headers.get('content-type') || '';

        if (contentType.includes('text/html')) {

            const html = await response.text();

            // 解析 canonical。
            const canonicalMatch =
                html.match(
                    /<link\b[^>]*\brel=["']canonical["'][^>]*>/i
                );

            let candidate = null;

            if (canonicalMatch) {
                const hrefMatch =
                    canonicalMatch[0].match(
                        /\bhref=["']([^"']+)["']/i
                    );

                if (hrefMatch) {
                    candidate = hrefMatch[1];
                }
            }

            // 解析 Meta Refresh。
            if (!candidate) {
                const refreshMatch =
                    html.match(
                        /<meta\b[^>]*http-equiv=["']refresh["'][^>]*>/i
                    );

                if (refreshMatch) {
                    const urlMatch =
                        refreshMatch[0].match(
                            /content=["'][^"']*url\s*=\s*([^"']+)["']/i
                        );

                    if (urlMatch) {
                        candidate = urlMatch[1];
                    }
                }
            }

            if (candidate) {

                const nextUrl = new URL(
                    candidate.replace(/&amp;/g, '&'),
                    parsed
                );

                if (
                    nextUrl.protocol === 'https:' &&
                    allowedHosts.includes(
                        nextUrl.hostname.toLowerCase()
                    )
                ) {
                    currentUrl = nextUrl.toString();
                    continue;
                }
            }
        }

        throw Object.assign(
            new Error('無法從短網址取得台灣商品頁'),
            { code: 'COUPANG_RESOLVE_NO_PRODUCT' }
        );
    }

    throw Object.assign(
        new Error('酷澎短網址跳轉次數過多'),
        { code: 'COUPANG_TOO_MANY_REDIRECTS' }
    );
}

// ==================================
// Shopee 轉換
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

        console.log(`[SHOPEE REQUEST] id=${requestId}`);

        const controller = new AbortController();

        const timeout = setTimeout(
            () => controller.abort(),
            SHOPEE_TIMEOUT
        );

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
                ` status=${shopeeRes.status}`
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
            return res.status(502).json({
                success: false,
                error_code: 'SHOPEE_EMPTY_RESULT',
                error: '蝦皮沒有回傳短網址',
                request_id: requestId
            });
        }

        console.log(`[SHOPEE SUCCESS] id=${requestId}`);

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

        return res.status(
            err.name === 'AbortError' ? 504 : 500
        ).json({
            success: false,

            error_code:
                err.name === 'AbortError'
                    ? 'SHOPEE_TIMEOUT'
                    : 'BACKEND_ERROR',

            error: '蝦皮轉換發生錯誤',
            request_id: requestId
        });
    }
});

// ==================================
// Coupang Partners API
// ==================================

app.post('/coupang/convert', async (req, res) => {

    const requestId = req.requestId;

    try {

        if (!COUPANG_ACCESS_KEY || !COUPANG_SECRET_KEY) {
            return res.status(503).json({
                success: false,
                error_code: 'COUPANG_CONFIG_MISSING',
                error: '酷澎 API 憑證尚未設定',
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
                error: '請提供酷澎網址',
                request_id: requestId
            });
        }

        const inputUrl = url.trim();

        if (!isCoupangInputUrl(inputUrl)) {
            return res.status(400).json({
                success: false,
                error_code: 'INVALID_COUPANG_URL',
                error: '不支援的酷澎網址格式',
                request_id: requestId
            });
        }

        let originUrl = inputUrl;

        // 短網址及 re2 網址交給後端處理。
        if (!isCoupangProductUrl(inputUrl)) {

            console.log(
                `[COUPANG SHORT INPUT] id=${requestId} 開始解析`
            );

            originUrl = await resolveCoupangUrl(
                inputUrl,
                requestId
            );
        }

        if (!isCoupangProductUrl(originUrl)) {
            return res.status(400).json({
                success: false,
                error_code: 'INVALID_COUPANG_PRODUCT_URL',
                error: '解析結果不是酷澎台灣商品頁',
                request_id: requestId
            });
        }

        console.log(
            `[COUPANG URL VERIFIED] id=${requestId} 商品網址驗證成功`
        );

        // ==================================
        // Coupang API HMAC
        // ==================================

        const method = 'POST';

        const apiPath =
            '/v2/providers/affiliate_open_api/apis/openapi/v1/deeplink';

        const apiUrl =
            `https://api-gateway.tw.coupang.com${apiPath}`;

        const signedDate = new Date()
            .toISOString()
            .replace(/[-:]/g, '')
            .replace(/\.\d{3}/, '')
            .slice(2);

        const message = signedDate + method + apiPath;

        const signature = crypto
            .createHmac('sha256', COUPANG_SECRET_KEY)
            .update(message)
            .digest('hex');

        const authorization =
            `CEA algorithm=HmacSHA256, access-key=${COUPANG_ACCESS_KEY}, signed-date=${signedDate}, signature=${signature}`;

        const payload = JSON.stringify({
            coupangUrls: [originUrl]
        });

        console.log(`[COUPANG REQUEST] id=${requestId}`);

        const controller = new AbortController();

        const timeout = setTimeout(
            () => controller.abort(),
            COUPANG_TIMEOUT
        );

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
                `[COUPANG API ERROR] id=${requestId}` +
                ` status=${coupangRes.status}` +
                ` response=${JSON.stringify(data)}`
            );

            return res.status(502).json({
                success: false,
                error_code: 'COUPANG_API_ERROR',
                error: data.message ||
                    data.rMessage ||
                    '酷澎 API 轉換失敗',

                request_id: requestId,
                upstream_status: coupangRes.status
            });
        }

        const result = Array.isArray(data.data)
            ? data.data[0]
            : null;

        const shortLink =
            result?.shortenUrl ||
            result?.shorten_url;

        if (!shortLink) {
            return res.status(502).json({
                success: false,
                error_code: 'COUPANG_EMPTY_RESULT',
                error: '酷澎沒有回傳推廣連結',
                request_id: requestId
            });
        }

        console.log(`[COUPANG SUCCESS] id=${requestId}`);

        return res.status(200).json({
            success: true,
            affiliate_url: shortLink,
            request_id: requestId,
            resolved_url: originUrl
        });

    } catch (err) {

        console.error(
            `[COUPANG ERROR] id=${requestId}`,
            err.code || err.name,
            err.message
        );

        const resolveErrors = {
            COUPANG_SHORT_RESOLVE_BLOCKED: 502,
            COUPANG_RESOLVE_TIMEOUT: 504,
            COUPANG_RESOLVE_CONNECTION_ERROR: 502,
            COUPANG_RESOLVE_HTTP_ERROR: 502,
            COUPANG_RESOLVE_NO_PRODUCT: 422,
            COUPANG_INVALID_REDIRECT: 422,
            COUPANG_REDIRECT_LOOP: 422,
            COUPANG_TOO_MANY_REDIRECTS: 422
        };

        if (err.code && resolveErrors[err.code]) {

            return res.status(resolveErrors[err.code]).json({
                success: false,
                error_code: err.code,
                error: err.message,
                request_id: requestId
            });
        }

        if (err.name === 'AbortError') {
            return res.status(504).json({
                success: false,
                error_code: 'COUPANG_TIMEOUT',
                error: '酷澎 API 等待逾時',
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
// 404
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
// JSON 錯誤
// ==================================

app.use((err, req, res, next) => {

    console.error('[EXPRESS ERROR]', err.message);

    if (res.headersSent) return next(err);

    res.status(err.status || 500).json({
        success: false,
        error_code: 'REQUEST_ERROR',
        error: '請求格式錯誤或伺服器處理失敗',
        request_id: req.requestId
    });
});

// ==================================
// 啟動
// ==================================

const server = app.listen(PORT, '0.0.0.0', () => {

    console.log('================================');
    console.log('Affiliate Backend 啟動成功');
    console.log(`Port: ${PORT}`);

    console.log(`APP_ID: ${APP_ID ? '已設定' : '未設定'}`);
    console.log(`APP_SECRET: ${APP_SECRET ? '已設定' : '未設定'}`);

    console.log(
        `COUPANG_ACCESS_KEY: ${COUPANG_ACCESS_KEY ? '已設定' : '未設定'}`
    );

    console.log(
        `COUPANG_SECRET_KEY: ${COUPANG_SECRET_KEY ? '已設定' : '未設定'}`
    );

    console.log('Shopee API：已啟用');
    console.log('Coupang Partners API：已啟用');
    console.log('Coupang re2：直接提取商品識別碼');
    console.log('Coupang coupa.ng：後端自動解析');
    console.log('診斷監控：已啟用');

    console.log('================================');
});

server.on('error', err => {
    console.error('[SERVER ERROR]', err);
});

process.on('unhandledRejection', reason => {
    console.error('[UNHANDLED REJECTION]', reason);
});

process.on('uncaughtException', err => {
    console.error('[UNCAUGHT EXCEPTION]', err);
    process.exit(1);
});
