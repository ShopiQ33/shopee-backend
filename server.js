
const express = require('express');
const crypto = require('crypto');
const cors = require('cors');

const app = express();

app.set('trust proxy', 1);

// ==================================
// 基本設定
// ==================================

const PORT = process.env.PORT || 10000;

const SHOPEE_TIMEOUT = 15000;
const COUPANG_TIMEOUT = 15000;
const COUPANG_RESOLVE_TIMEOUT = 12000;
const IFREESITE_TIMEOUT = 12000;
const MAX_REDIRECTS = 8;

const APP_ID = process.env.APP_ID;
const APP_SECRET = process.env.APP_SECRET;

const COUPANG_ACCESS_KEY = process.env.COUPANG_ACCESS_KEY;
const COUPANG_SECRET_KEY = process.env.COUPANG_SECRET_KEY;

const IFREESITE_URL =
    'https://01.ifreesite.com/longurl/url.php';

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
// 商品網址重建
// ==================================

function buildCoupangProductUrl(pageKey, itemId, vendorItemId) {
    if (!pageKey || !/^\d+$/.test(pageKey)) {
        return null;
    }

    if (itemId && !/^\d+$/.test(itemId)) {
        return null;
    }

    if (vendorItemId && !/^\d+$/.test(vendorItemId)) {
        return null;
    }

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

    return productUrl.toString();
}

// ==================================
// re2 網址直接解析
// ==================================

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

    if (!pageKey) {
        const deepLinkValue = params.get('deep_link_value');

        if (deepLinkValue) {
            try {
                const deepLink = new URL(deepLinkValue);
                pageKey = deepLink.searchParams.get('pId');
            } catch {
                // 忽略無效 deep link
            }
        }
    }

    const itemId = params.get('itemId');
    const vendorItemId = params.get('vendorItemId');

    const productUrl = buildCoupangProductUrl(
        pageKey,
        itemId,
        vendorItemId
    );

    if (!productUrl) {
        console.warn(
            `[COUPANG RE2] id=${requestId} 商品資訊不完整`
        );
        return null;
    }

    console.log(
        `[COUPANG RE2 SUCCESS] id=${requestId}` +
        ` pageKey=${pageKey}` +
        ` itemId=${itemId || 'none'}` +
        ` vendorItemId=${vendorItemId || 'none'}`
    );

    return productUrl;
}

// ==================================
// OneLink 網址解析
// ==================================

function resolveCoupangOneLink(inputUrl, requestId) {
    const parsed = parseSafeUrl(inputUrl);

    if (!parsed) return null;

    if (
        parsed.hostname.toLowerCase() !==
        'coupang.onelink.me'
    ) {
        return null;
    }

    const params = parsed.searchParams;

    // 第一優先：af_r 裡面的 re2 網址
    const afR = params.get('af_r');

    if (afR) {
        try {
            const redirectUrl = new URL(afR);

            if (
                redirectUrl.hostname.toLowerCase() ===
                'link.tw.coupang.com'
            ) {
                const re2Result = resolveCoupangRe2Url(
                    redirectUrl.toString(),
                    requestId
                );

                if (re2Result) {
                    console.log(
                        `[COUPANG ONELINK] id=${requestId} 使用 af_r`
                    );

                    return re2Result;
                }
            }
        } catch {
            // 繼續嘗試 deep_link_value
        }
    }

    // 第二優先：deep_link_value
    const deepLinkValue = params.get('deep_link_value');

    if (deepLinkValue) {
        try {
            const deepLink = new URL(deepLinkValue);

            if (deepLink.protocol === 'coupang:') {
                const pageKey =
                    deepLink.searchParams.get('pId');

                const itemId =
                    deepLink.searchParams.get('itemId');

                const vendorItemId =
                    deepLink.searchParams.get('vendorItemId');

                const productUrl = buildCoupangProductUrl(
                    pageKey,
                    itemId,
                    vendorItemId
                );

                if (productUrl) {
                    console.log(
                        `[COUPANG ONELINK] id=${requestId} 使用 deep_link_value`
                    );

                    return productUrl;
                }
            }
        } catch {
            // 忽略無效 deep link
        }
    }

    return null;
}

// ==================================
// HTML 實體解碼
// ==================================

function decodeHtmlEntities(value) {
    return String(value)
        .replace(/&amp;/gi, '&')
        .replace(/&quot;/gi, '"')
        .replace(/&#39;/gi, "'")
        .replace(/&apos;/gi, "'")
        .replace(/&#x2f;/gi, '/')
        .replace(/&#x3a;/gi, ':')
        .replace(/&#(\d+);/g, (_, code) => {
            return String.fromCharCode(Number(code));
        })
        .replace(/&#x([0-9a-f]+);/gi, (_, code) => {
            return String.fromCharCode(parseInt(code, 16));
        });
}

// ==================================
// 從 HTML 擷取酷澎連結
// ==================================

function extractCoupangLinksFromHtml(html) {
    const links = [];

    const hrefRegex =
        /href\s*=\s*["']([^"']+)["']/gi;

    let match;

    while ((match = hrefRegex.exec(html)) !== null) {
        const href = decodeHtmlEntities(match[1]).trim();

        try {
            const url = new URL(href);

            const host = url.hostname.toLowerCase();

            if (
                COUPANG_REDIRECT_HOSTS.includes(host) ||
                COUPANG_PRODUCT_HOSTS.includes(host)
            ) {
                links.push(url.toString());
            }
        } catch {
            // 忽略無效網址
        }
    }

    // 去除重複網址
    return [...new Set(links)];
}

// ==================================
// iFreeSite 自動還原 coupa.ng
// ==================================

async function resolveCoupangWithIFreeSite(
    inputUrl,
    requestId
) {
    console.log(
        `[IFREESITE REQUEST] id=${requestId} 開始還原`
    );

    const controller = new AbortController();

    const timeout = setTimeout(
        () => controller.abort(),
        IFREESITE_TIMEOUT
    );

    let response;

    try {
        const formData = new URLSearchParams();

        formData.set('turl', inputUrl);
        formData.set('url_done', 'done');

        response = await fetch(IFREESITE_URL, {
            method: 'POST',
            redirect: 'follow',

            headers: {
                'Content-Type':
                    'application/x-www-form-urlencoded',

                'Accept':
                    'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',

                'User-Agent':
                    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) ' +
                    'AppleWebKit/537.36 (KHTML, like Gecko) ' +
                    'Chrome/131.0.0.0 Safari/537.36',

                'Origin':
                    'https://www.ifreesite.com',

                'Referer':
                    'https://www.ifreesite.com/longurl/'
            },

            body: formData.toString(),
            signal: controller.signal
        });

    } catch (err) {
        if (err.name === 'AbortError') {
            throw Object.assign(
                new Error('iFreeSite 還原逾時'),
                { code: 'IFREESITE_TIMEOUT' }
            );
        }

        throw Object.assign(
            new Error('無法連接 iFreeSite'),
            { code: 'IFREESITE_CONNECTION_ERROR' }
        );

    } finally {
        clearTimeout(timeout);
    }

    if (response.status === 403 || response.status === 503) {
        console.warn(
            `[IFREESITE BLOCKED] id=${requestId}` +
            ` HTTP ${response.status}`
        );

        throw Object.assign(
            new Error(
                'iFreeSite 或 Cloudflare 拒絕伺服器請求'
            ),
            { code: 'IFREESITE_CLOUDFLARE_BLOCKED' }
        );
    }

    if (!response.ok) {
        throw Object.assign(
            new Error(`iFreeSite HTTP ${response.status}`),
            { code: 'IFREESITE_HTTP_ERROR' }
        );
    }

    const html = await response.text();

    if (!html || html.length < 20) {
        throw Object.assign(
            new Error('iFreeSite 回傳內容為空'),
            { code: 'IFREESITE_INVALID_RESPONSE' }
        );
    }

    if (
        /cf-chl-|challenge-platform|Just a moment|Enable JavaScript and cookies/i
            .test(html)
    ) {
        throw Object.assign(
            new Error('iFreeSite 回傳 Cloudflare 驗證頁'),
            { code: 'IFREESITE_CLOUDFLARE_BLOCKED' }
        );
    }

    const links = extractCoupangLinksFromHtml(html);

    console.log(
        `[IFREESITE RESPONSE] id=${requestId}` +
        ` links=${links.length}`
    );

    // 先找 re2
    for (const link of links) {
        const result = resolveCoupangRe2Url(
            link,
            requestId
        );

        if (result) {
            console.log(
                `[IFREESITE SUCCESS] id=${requestId} type=re2`
            );

            return result;
        }
    }

    // 再找 OneLink
    for (const link of links) {
        const result = resolveCoupangOneLink(
            link,
            requestId
        );

        if (result) {
            console.log(
                `[IFREESITE SUCCESS] id=${requestId} type=onelink`
            );

            return result;
        }
    }

    // 最後檢查是否直接回傳商品網址
    for (const link of links) {
        if (isCoupangProductUrl(link)) {
            console.log(
                `[IFREESITE SUCCESS] id=${requestId} type=product`
            );

            return link;
        }
    }

    throw Object.assign(
        new Error(
            'iFreeSite 已回應，但找不到有效的酷澎商品資訊'
        ),
        { code: 'IFREESITE_NO_PRODUCT' }
    );
}

// ==================================
// 酷澎短網址自動解析
// ==================================

async function resolveCoupangUrl(inputUrl, requestId) {

    // 第一優先：re2 直接解析
    const directRe2 = resolveCoupangRe2Url(
        inputUrl,
        requestId
    );

    if (directRe2) {
        return directRe2;
    }

    // 第二優先：OneLink 直接解析
    const directOneLink = resolveCoupangOneLink(
        inputUrl,
        requestId
    );

    if (directOneLink) {
        return directOneLink;
    }

    const inputParsed = parseSafeUrl(inputUrl);

    if (!inputParsed) {
        throw Object.assign(
            new Error('網址格式不安全'),
            { code: 'COUPANG_INVALID_REDIRECT' }
        );
    }

    const inputHost = inputParsed.hostname.toLowerCase();

    // 第三優先：coupa.ng 交給 iFreeSite 嘗試還原
    if (
        inputHost === 'coupa.ng' ||
        inputHost === 'www.coupa.ng'
    ) {
        return await resolveCoupangWithIFreeSite(
            inputUrl,
            requestId
        );
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

        const re2Result = resolveCoupangRe2Url(
            parsed.toString(),
            requestId
        );

        if (re2Result) {
            return re2Result;
        }

        const oneLinkResult = resolveCoupangOneLink(
            parsed.toString(),
            requestId
        );

        if (oneLinkResult) {
            return oneLinkResult;
        }

        if (COUPANG_PRODUCT_HOSTS.includes(hostname)) {
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

            const links = extractCoupangLinksFromHtml(html);

            for (const link of links) {
                const result = resolveCoupangRe2Url(
                    link,
                    requestId
                );

                if (result) return result;
            }

            for (const link of links) {
                const result = resolveCoupangOneLink(
                    link,
                    requestId
                );

                if (result) return result;
            }

            for (const link of links) {
                if (isCoupangProductUrl(link)) {
                    return link;
                }
            }

            // Canonical
            const canonicalMatch = html.match(
                /<link\b[^>]*\brel=["']canonical["'][^>]*>/i
            );

            if (canonicalMatch) {
                const hrefMatch = canonicalMatch[0].match(
                    /\bhref=["']([^"']+)["']/i
                );

                if (hrefMatch) {
                    const candidate = new URL(
                        decodeHtmlEntities(hrefMatch[1]),
                        parsed
                    );

                    if (
                        candidate.protocol === 'https:' &&
                        allowedHosts.includes(
                            candidate.hostname.toLowerCase()
                        )
                    ) {
                        currentUrl = candidate.toString();
                        continue;
                    }
                }
            }

            // Meta Refresh
            const refreshMatch = html.match(
                /<meta\b[^>]*http-equiv=["']refresh["'][^>]*>/i
            );

            if (refreshMatch) {
                const urlMatch = refreshMatch[0].match(
                    /content=["'][^"']*url\s*=\s*([^"']+)["']/i
                );

                if (urlMatch) {
                    const candidate = new URL(
                        decodeHtmlEntities(urlMatch[1]),
                        parsed
                    );

                    if (
                        candidate.protocol === 'https:' &&
                        allowedHosts.includes(
                            candidate.hostname.toLowerCase()
                        )
                    ) {
                        currentUrl = candidate.toString();
                        continue;
                    }
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

        // 商品網址不需要解析
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
                error:
                    data.message ||
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
            COUPANG_TOO_MANY_REDIRECTS: 422,

            IFREESITE_TIMEOUT: 504,
            IFREESITE_CONNECTION_ERROR: 502,
            IFREESITE_HTTP_ERROR: 502,
            IFREESITE_INVALID_RESPONSE: 502,
            IFREESITE_CLOUDFLARE_BLOCKED: 502,
            IFREESITE_NO_PRODUCT: 422
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
// JSON 錯誤處理
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
    console.log('Coupang re2：直接解析商品資訊');
    console.log('Coupang OneLink：自動解析商品資訊');
    console.log('Coupang coupa.ng：iFreeSite 自動還原嘗試');
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
