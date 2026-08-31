const express = require('express');
const cors = require('cors');
const crypto = require('crypto');

const app = express();
app.use(cors());
app.use(express.json());

// 從 Render 環境變數讀取金鑰
const APP_ID = process.env.SHOPEE_APP_ID;
const APP_SECRET = process.env.SHOPEE_APP_SECRET;

function generateSignature(payload, timestamp) {
    const factor = `${APP_ID}${timestamp}${payload}${APP_SECRET}`;
    return crypto.createHash('sha256').update(factor).digest('hex');
}

app.post('/convert', async (req, res) => {
    try {
        const { url } = req.body;
        if (!url) return res.status(400).json({ error: '請提供 URL' });

        const timestamp = Math.floor(Date.now() / 1000);
        const query = `
            mutation {
                generateShortLink(input: { originUrl: "${url}" }) {
                    shortLink
                }
            }
        `;

        const signature = generateSignature(query, timestamp);

        const response = await fetch('https://open-api.affiliate.shopee.tw/graphql', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `SHA256 Credential=${APP_ID}, Timestamp=${timestamp}, Signature=${signature}`
            },
            body: JSON.stringify({ query })
        });

        const result = await response.json();

        if (result.errors) {
            return res.status(400).json({ error: result.errors[0].message });
        }

        const shortLink = result.data.generateShortLink.shortLink;
        res.json({ affiliate_url: shortLink });

    } catch (err) {
        console.error(err);
        res.status(500).json({ error: '轉換失敗' });
    }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
