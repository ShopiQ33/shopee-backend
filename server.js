app.post('/convert', async (req, res) => {
    try {
        const { url } = req.body;

        if (!url) {
            return res.status(400).json({ error: "缺少 url 參數" });
        }

        // 直接把使用者輸入的網址（不管是長還是短）送給蝦皮 API，讓蝦皮自己去解析
        const payload = JSON.stringify({
            query: `mutation{generateShortLink(input:{originUrl:"${url.trim()}"}){shortLink}}`
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
            return res.status(400).json({ error: "無法產生短連結" });
        }

    } catch (err) {
        console.error("伺服器內部錯誤:", err);
        res.status(500).json({ error: "伺服器內部錯誤" });
    }
});
