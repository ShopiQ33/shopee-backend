
const express = require('express');
const crypto = require('crypto');

const app = express();

// 接收 JSON 格式請求
app.use(express.json());

// 蝦皮 API 環境變數
const APP_ID = process.env.APP_ID;
const APP_SECRET = process.env.APP_SECRET;

// 檢查環境變數
if (!APP_ID || !APP_SECRET) {
    console.error('錯誤：缺少 APP_ID 或 APP_SECRET');
    process.exit(1);
}

// 蝦皮短連結轉換 API
app.post('/convert', async (req, res) => {
    try {
        const { url } = req.body || {};

        // 檢查網址
        if (!url || typeof url !== 'string' || !url.trim()) {
            return res.status(400).json({
                error: '缺少有效的 url 參數'
            });
        }

        const originUrl = url.trim();

        // 建立 GraphQL 請求
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

        // 建立時間戳記及 SHA256 簽名
        const timestamp = Math.floor(Date.now() / 1000);

        const factor = `${APP_ID}${timestamp}${payload}${APP_SECRET}`;

        const signature = crypto
            .createHash('sha256')
            .update(factor)
            .digest('hex');

        // 呼叫蝦皮 Affiliate API
        const shopeeRes = await fetch(
            'https://open-api.affiliate.shopee.tw/graphql',
            {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'Authorization': `SHA256 Credential=${APP_ID}, Timestamp=${timestamp}, Signature=${signature}`
                },
                body: payload
            }
        );

        const data = await shopeeRes.json();

        // 檢查蝦皮 API 回應
        if (!shopeeRes.ok || data.errors) {
            console.error(
                '蝦皮 API 回傳錯誤:',
                JSON.stringify(data, null, 2)
            );

            return res.status(502).json({
                error: '蝦皮 API 轉換失敗',
                details: data.errors || data
            });
        }

        // 取得短連結
        const shortLink = data.data?.generateShortLink?.shortLink;

        if (shortLink) {
            return res.json({
                affiliate_url: shortLink
            });
        }

        return res.status(400).json({
            error: '無法產生短連結'
        });

    } catch (err) {
        console.error('伺服器內部錯誤:', err);

        return res.status(500).json({
            error: '伺服器內部錯誤'
        });
    }
});

// 健康檢查
app.get('/', (req, res) => {
    res.json({
        status: 'ok',
        message: 'Shopee Backend is running!'
    });
});

// 啟動伺服器
const PORT = process.env.PORT || 3000;

app.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
});
