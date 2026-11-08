const express = require('express');
const crypto = require('crypto');
const cors = require('cors');

const app = express();

// CORS 跨來源設定
app.use(cors({
    origin: 'https://shopiq33.github.io',
    methods: ['GET', 'POST', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization']
}));

// 接收 JSON 格式請求
app.use(express.json({ limit: '1mb' }));

// 蝦皮 API 環境變數
const APP_ID = process.env.APP_ID;
const APP_SECRET = process.env.APP_SECRET;

// 檢查環境變數
if (!APP_ID || !APP_SECRET) {
    console.error('CONFIG_ERROR：缺少 APP_ID 或 APP_SECRET');
    process.exit(1);
}

// 健康檢查
app.get('/', (req, res) => {
    res.status(200).json({
        status: 'ok',
        message: 'Shopee Backend is running!',
        config: {
            appId: Boolean(APP_ID),
            appSecret: Boolean(APP_SECRET)
        }
    });
});

// 蝦皮短連結轉換 API
app.post('/convert', async (req, res) => {
    const requestId = crypto.randomUUID();

    try {
        const { url } = req.body || {};

        // 檢查連結
        if (!url || typeof url !== 'string' || !url.trim()) {
            return res.status(400).json({
                success: false,
                error_code: 'INVALID_URL',
                error: '請提供有效的商品連結',
                request_id: requestId
            });
        }

        const originUrl = url.trim();

        // 檢查網址格式
        let parsedUrl;

        try {
            parsedUrl = new URL(originUrl);
        } catch {
            return res.status(400).json({
                success: false,
                error_code: 'INVALID_URL',
                error: '商品連結格式不正確',
                request_id: requestId
            });
        }

        if (!['http:', 'https:'].includes(parsedUrl.protocol)) {
            return res.status(400).json({
                success: false,
                error_code: 'INVALID_URL',
                error: '商品連結必須使用 HTTP 或 HTTPS',
                request_id: requestId
            });
        }

        // 建立蝦皮 API 請求
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
        const factor = `${APP_ID}${timestamp}${payload}${APP_SECRET}`;

        const signature = crypto
            .createHash('sha256')
            .update(factor)
            .digest('hex');

        console.log(`[${requestId}] 開始呼叫蝦皮 API`);

        // 呼叫蝦皮 API，最多等待 25 秒
        let shopeeRes;

        try {
            shopeeRes = await fetch(
                'https://open-api.affiliate.shopee.tw/graphql',
                {
                    method: 'POST',
                    headers: {
                        'Content-Type': 'application/json',
                        'Authorization': `SHA256 Credential=${APP_ID}, Timestamp=${timestamp}, Signature=${signature}`
                    },
                    body: payload,
                    signal: AbortSignal.timeout(25000)
                }
            );
        } catch (err) {
            if (err.name === 'TimeoutError' || err.name === 'AbortError') {
                console.error(`[${requestId}] SHOPEE_TIMEOUT：蝦皮 API 逾時`);

                return res.status(504).json({
                    success: false,
                    error_code: 'SHOPEE_TIMEOUT',
                    error: '蝦皮 API 回應逾時，請稍後再試',
                    request_id: requestId
                });
            }

            console.error(`[${requestId}] SHOPEE_CONNECTION_ERROR：`, err.message);

            return res.status(502).json({
                success: false,
                error_code: 'SHOPEE_CONNECTION_ERROR',
                error: '無法連接蝦皮 API，請稍後再試',
                request_id: requestId
            });
        }

        // 讀取蝦皮 API 回應
        let data;

        try {
            data = await shopeeRes.json();
        } catch {
            console.error(
                `[${requestId}] SHOPEE_INVALID_RESPONSE：蝦皮回傳非 JSON 資料`
            );

            return res.status(502).json({
                success: false,
                error_code: 'SHOPEE_INVALID_RESPONSE',
                error: '蝦皮 API 回傳資料格式異常',
                request_id: requestId
            });
        }

        // 判斷蝦皮 API 錯誤
        if (!shopeeRes.ok || data.errors) {
            const errorText = JSON.stringify(data.errors || data);

            const authError =
                shopeeRes.status === 401 ||
                shopeeRes.status === 403 ||
                /signature|credential|unauthorized|authentication/i.test(errorText);

            const errorCode = authError
                ? 'SHOPEE_AUTH_ERROR'
                : 'SHOPEE_API_ERROR';

            console.error(
                `[${requestId}] ${errorCode}：HTTP ${shopeeRes.status}`,
                errorText
            );

            return res.status(502).json({
                success: false,
                error_code: errorCode,
                error: authError
                    ? '蝦皮 API 認證失敗，請檢查 APP_ID、APP_SECRET 或簽名設定'
                    : '蝦皮 API 回應錯誤，請稍後再試',
                request_id: requestId,
                upstream_status: shopeeRes.status
            });
        }

        // 取得轉換結果
        const shortLink = data.data?.generateShortLink?.shortLink;

        if (!shortLink) {
            console.error(
                `[${requestId}] SHOPEE_EMPTY_RESULT：`,
                JSON.stringify(data)
            );

            return res.status(502).json({
                success: false,
                error_code: 'SHOPEE_EMPTY_RESULT',
                error: '蝦皮 API 沒有回傳短連結',
                request_id: requestId
            });
        }

        console.log(`[${requestId}] 轉換成功`);

        return res.status(200).json({
            success: true,
            affiliate_url: shortLink,
            request_id: requestId
        });

    } catch (err) {
        console.error(
            `[${requestId}] BACKEND_ERROR：`,
            err.stack || err.message
        );

        return res.status(500).json({
            success: false,
            error_code: 'BACKEND_ERROR',
            error: '後端伺服器發生內部錯誤',
            request_id: requestId
        });
    }
});

// 找不到的 API 路徑
app.use((req, res) => {
    res.status(404).json({
        success: false,
        error_code: 'NOT_FOUND',
        error: '找不到此 API 路徑'
    });
});

// JSON 格式錯誤等 Express 中介層錯誤
app.use((err, req, res, next) => {
    console.error('REQUEST_ERROR：', err.message);

    if (err.type === 'entity.parse.failed') {
        return res.status(400).json({
            success: false,
            error_code: 'INVALID_JSON',
            error: '請求資料格式錯誤'
        });
    }

    return res.status(500).json({
        success: false,
        error_code: 'BACKEND_ERROR',
        error: '伺服器處理請求時發生錯誤'
    });
});

// 啟動伺服器
const PORT = process.env.PORT || 3000;

app.listen(PORT, () => {
    console.log(`Shopee Backend running on port ${PORT}`);
    console.log('APP_ID：已設定');
    console.log('APP_SECRET：已設定');
});
