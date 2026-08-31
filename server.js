const express = require('express');
const cors = require('cors');
const crypto = require('crypto');
const fetch = require('node-fetch'); // 若 Node.js 版本較舊需要，Node 18+ 可省略

const app = express();

// 🔥 關鍵 1：必須允許 CORS 與解析 JSON
app.use(cors());
app.use(express.json());

// 設定蝦皮金鑰（會優先讀取 Render 的 Environment Variables）
const APP_ID = process.env.SHOPEE_APP_ID;
const APP_SECRET = process.env.SHOPEE_APP_SECRET;

app.post('/convert', async (req, res) => {
    try {
        // 🔥 關鍵 2：拿取前端傳過來的 url 欄位
        const { url } = req.body;

        if (!url) {
            return res.status(400).json({ error: "缺少 url 參數" });
        }

        // 準備 GraphQL 請求
        const query = `
            mutation {
                generateShortLink(input: { originUrl: "${url}" }) {
                    shortLink
                }
            }
        `;

        const timestamp = Math.floor(Date.now() / 1000);
        const factor = APP_ID + timestamp + query + APP_SECRET;
        const signature = crypto.createHash('sha256').update(factor).digest('hex');

        // 呼叫蝦皮官方 API
        const shopeeRes = await fetch('https://open-api.affiliate.shopee.tw/graphql', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `SHA256 Credential=${APP_ID}, Timestamp=${timestamp}, Signature=${signature}`
            },
            body: JSON.stringify({ query })
        });

        const data = await shopeeRes.json();

        if (data.errors) {
            console.error("蝦皮 API 回傳錯誤:", data.errors);
            return res.status(500).json({ error: "蝦皮 API 轉換失敗", details: data.errors });
        }

        const shortLink = data.data?.generateShortLink?.shortLink;

        if (shortLink) {
            // 成功回傳短連結給前端
            return res.json({ affiliate_url: shortLink });
        } else {
            return res.status(400).json({ error: "無法產生短連結，請確認網址是否為有效蝦皮商品" });
        }

    } catch (err) {
        console.error("伺服器內部錯誤:", err);
        res.status(500).json({ error: "伺服器內部錯誤" });
    }
});

// Render 會自動注入 PORT 變數
const PORT = process.env.PORT || 10000;
app.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
});
