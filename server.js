const express = require('express');
const cors = require('cors');
const crypto = require('crypto');

const app = express();

app.use(cors());
app.use(express.json());

const APP_ID = (process.env.SHOPEE_APP_ID || '').trim();
const APP_SECRET = (process.env.SHOPEE_APP_SECRET || '').trim();

// 【新增】短網址展開與清理函式
async function expandShopeeUrl(inputUrl) {
    try {
        if (!inputUrl.includes('shp.ee') && !inputUrl.includes('shopee.tw/s/') && !inputUrl.includes('s.shopee.tw')) {
            return inputUrl;
        }

        const response = await fetch(inputUrl, {
            method: 'GET',
            redirect: 'follow'
        });

        const finalUrl = response.url || inputUrl;
        return finalUrl.split('?')[0];
    } catch (error) {
        console.error("短網址展開失敗:", error.message);
        return inputUrl;
    }
}

app.post('/convert', async (req, res) => {
    try {
        const { url } = req.body;

        if (!url) {
            return res.status(400).json({ error: "缺少 url 參數" });
        }

        // 【修改】先將短網址展開並清理乾淨，再組裝進 GraphQL payload
        const cleanTargetUrl = await expandShopeeUrl(url);

        const payload = JSON.stringify({
            query: `mutation{generateShortLink(input:{originUrl:"${cleanTargetUrl}"}){shortLink}}`
        });

        const timestamp = Math.floor(Date.now() / 1000);
        
        const factor = `${APP_ID}${timestamp}${payload}${APP_SECRET}`;
        const signature = crypto.createHash('sha256').update(factor).digest('hex');

        const shopeeRes = await fetch('https://open-api.affiliate.shopee.tw/graphql', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `SHA256 Credential=${APP_ID}, Timestamp=${timestamp}, Signature=${signature}`
            },
            body: payload
        });

        const data = await shopeeRes.json();

        if (data.errors) {
            console.error("蝦皮 API 回傳錯誤:", JSON.stringify(data.errors, null, 2));
            return res.status(500).json({ error: "蝦皮 API 轉換失敗", details: data.errors });
        }

        const shortLink = data.data?.generateShortLink?.shortLink;

        if (shortLink) {
            return res.json({ affiliate_url: shortLink });
        } else {
            return res.status(400).json({ error: "無法產生短連結，請確認網址是否為有效蝦皮商品" });
        }

    } catch (err) {
        console.error("伺服器內部錯誤:", err);
        res.status(500).json({ error: "伺服器內部錯誤" });
    }
});

const PORT = process.env.PORT || 10000;
app.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
});
