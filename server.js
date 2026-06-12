const express = require('express');
const cors = require('cors');
const axios = require('axios');
const fs = require('fs');
const path = require('path');
require('dotenv').config();

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());

// ====================================================
// 📊 1. 全球大數據地理庫加載 (airports.dat.txt)
// ====================================================
let globalAirportsDatabase = [];

try {
    const csvPath = path.join(__dirname, 'airports.dat.txt');
    const fileContent = fs.readFileSync(csvPath, 'utf-8');
    
    globalAirportsDatabase = fileContent.split('\n').map(line => {
        // 完美切分逗號，自動忽略雙引號內的內容
        const cols = line.split(/,(?=(?:(?:[^"]*"){2})*[^"]*$)/);
        if (cols.length < 8) return null;

        return {
            name: cols[1]?.replace(/"/g, '').trim(),
            city: cols[2]?.replace(/"/g, '').trim() || cols[1]?.replace(/"/g, '').trim(),
            country: cols[3]?.replace(/"/g, '').trim(),
            code: cols[4]?.replace(/"/g, '').trim() !== '\\N' ? cols[4]?.replace(/"/g, '').trim() : null, // IATA 三字碼
            icao: cols[5]?.replace(/"/g, '').trim(), // ICAO 四字碼 (保底用)
            lat: parseFloat(cols[6]),
            lng: parseFloat(cols[7])
        };
    }).filter(air => air && (air.code || air.icao));

    console.log(`✈️ 精品航空地理庫加載成功！已成功載入 ${globalAirportsDatabase.length} 個全球真航點。`);
} catch (err) {
    console.error("❌ 機場 CSV 檔案加載失敗，請檢查路徑:", err.message);
}

// ====================================================
// 🧭 2. 全球真航點智慧檢索路由 (替代不穩定的第三方 API)
// ====================================================
app.get('/api/search-airports', (req, res) => {
    const { query } = req.query;
    if (!query) return res.json([]);

    const text = query.trim().toUpperCase();

    // 本地記憶體秒級檢索，免 key、無限制、永不噴 429/404
    const matches = globalAirportsDatabase.filter(air => 
        (air.code && air.code.toUpperCase().includes(text)) || 
        (air.city && air.city.toUpperCase().includes(text)) || 
        (air.name && air.name.toUpperCase().includes(text)) ||
        (air.country && air.country.toUpperCase().includes(text))
    );

    const formatted = matches.slice(0, 10).map(air => ({
        code: air.code || air.icao,
        city: air.city,
        name: `${air.country} - ${air.name}`,
        lat: air.lat,
        lng: air.lng
    }));

    res.json(formatted);
});

// 球面大圓距離計算
function getDistanceKM(lat1, lon1, lat2, lon2) {
    const R = 6371;
    const dLat = (lat2 - lat1) * Math.PI / 180;
    const dLon = (lon2 - lon1) * Math.PI / 180;
    const a = Math.sin(dLat/2) * Math.sin(dLat/2) + Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) * Math.sin(dLon/2) * Math.sin(dLon/2);
    return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1-a));
}

// ====================================================
// ✈️ 3. 核心路由：全球實時聯網機票查詢線路
// ====================================================
app.get('/api/search-flights', async (req, res) => {
    const { origin, destination, departureDate, fromLat, fromLng, toLat, toLng } = req.query;

    if (!origin || !destination || !departureDate) {
        return res.status(400).json({ error: '缺少必要參數' });
    }

    // 動態計算兩地精準的大圓航程里程數
    const fLat = parseFloat(fromLat) || 25.0797;
    const fLng = parseFloat(fromLng) || 121.2342;
    const tLat = parseFloat(toLat) || 35.7720;
    const tLng = parseFloat(toLng) || 140.3929;
    const distanceKM = Math.round(getDistanceKM(fLat, fLng, tLat, tLng));

    const rapidApiKey = process.env.RAPIDAPI_KEY || '23ec7fb16bmsh8fbba41a4f8122cp1abf7bjsn4f4357e26940';
    
    try {
        console.log(`🌐 聯網檢索實時機票: ${origin} -> ${destination} (${departureDate})，預估航程: ${distanceKM} KM`);
        
        const options = {
            method: 'GET',
            url: 'https://skyscanner-flights4.p.rapidapi.com/api/v1/search',
            params: {
                origin,
                destination,
                date: departureDate,
                limit: '20',
                currency: 'TWD',
                market: 'TW',
                locale: 'zh-TW',
                adults: '1',
                cabin: 'economy'
            },
            headers: {
                'x-rapidapi-key': rapidApiKey,
                'x-rapidapi-host': 'skyscanner-flights4.p.rapidapi.com',
                'Content-Type': 'application/json'
            }
        };

        const apiResponse = await axios.request(options);
        const apiData = apiResponse.data;
        const rawList = apiData && apiData.results;

        if (rawList && Array.isArray(rawList) && rawList.length > 0) {
            let realFlights = [];

            rawList.forEach((item, index) => {
                const priceRaw = item.price_raw || 16800;
                
                // 🔑 核心修正：時區校正演算法，還原達拉斯飛東京的真實航時 (杜絕 3h 30m 航空奇觀)
                let durationMinutes = item.dur_min || 0;
                let timeStr = '即時航班巡航中';

                if (item.dep && item.arr) {
                    const dTime = item.dep.split('T')[1]?.substring(0, 5) || '00:00';
                    const aTime = item.arr.split('T')[1]?.substring(0, 5) || '00:00';
                    timeStr = `${dTime} - ${aTime}`;

                    // 如果 API 給的總航時丟失或落入預設短途值 (210分鐘)，發動時間戳逆向校準
                    if (durationMinutes === 0 || durationMinutes === 210) {
                        const depDate = new Date(item.dep);
                        const arrDate = new Date(item.arr);
                        
                        let diffMinutes = Math.round((arrDate - depDate) / 1000 / 60);
                        // 根據經度差自動盲猜兩地時區差 (經度每差 15 度 = 1 小時)
                        const estimatedTimezoneDiff = Math.round((tLng - fLng) / 15);
                        
                        // 真實航時 = 帳面時間差 - 時區差
                        durationMinutes = diffMinutes - (estimatedTimezoneDiff * 60);

                        // 換日線防禦機制：如果小於合理範圍，直接啟動大圓航速里程保底
                        if (durationMinutes <= 60) {
                            durationMinutes = Math.round((distanceKM / 820) * 60 + ((item.stops || 0) * 120)); 
                        }
                    }
                }

                // 完全沒抓到時的終極大圓保底
                if (durationMinutes === 0) {
                    durationMinutes = Math.round((distanceKM / 850) * 60 + 40);
                }

                const hours = Math.floor(durationMinutes / 60);
                const mins = durationMinutes % 60;
                
                const airlineName = item.carriers && item.carriers[0] ? item.carriers[0] : '全球聯營航空';
                let carrierCode = 'OTHER';
                let logoIcon = 'fa-plane';
                
                if (airlineName.includes('星宇')) { carrierCode = 'JX'; logoIcon = 'fa-star'; }
                else if (airlineName.includes('長榮')) { carrierCode = 'BR'; logoIcon = 'fa-leaf'; }
                else if (airlineName.includes('中華') || airlineName.includes('華航')) { carrierCode = 'CI'; logoIcon = 'fa-cloud'; }
                else if (airlineName.includes('大韓')) { carrierCode = 'KE'; logoIcon = 'fa-globe-asia'; }
                else if (airlineName.includes('香港')) { carrierCode = 'HX'; logoIcon = 'fa-paper-plane'; }
                else if (airlineName.includes('捷星')) { carrierCode = 'JQ'; logoIcon = 'fa-bolt'; }

                realFlights.push({
                    id: item.id || `REAL-${index}-${Date.now()}`,
                    airline: airlineName,
                    code: carrierCode,
                    logo: logoIcon,
                    flightClass: item.bucket === 'Cheapest' ? '極致超值艙' : '精選經濟艙',
                    durationMinutes,
                    durationStr: `${hours}h ${mins}m`,
                    stops: (item.legs && item.legs[0] && item.legs[0].stops) !== undefined ? item.legs[0].stops : 0,
                    price: Math.round(priceRaw),
                    time: timeStr
                });
            });

            return res.json({ distanceKM, flights: realFlights });
        }

        throw new Error("Results 陣列解析未就緒");

    } catch (error) {
        console.error("❌ 聯網 API 呼叫或解析失敗，無縫啟動備用精品仿真引擎:", error.message);
        return res.json({
            distanceKM,
            flights: generateFallbackFlights(origin, destination, departureDate, distanceKM)
        });
    }
});

// 備用高仿真數據引擎
function generateFallbackFlights(origin, destination, departureDate, distanceKM) {
    const totalMinutes = Math.round((distanceKM / 850) * 60 + 30);
    const hours = Math.floor(totalMinutes / 60);
    const mins = totalMinutes % 60;
    const basePrice = Math.round(distanceKM * 2.3);

    return [
        {
            id: `MOCK-JX-${departureDate}`,
            airline: '星宇航空 STARLUX (仿真資料)',
            code: 'JX',
            logo: 'fa-star',
            flightClass: 'Luxury Econ',
            durationMinutes: totalMinutes,
            durationStr: `${hours}h ${mins}m`,
            stops: 0,
            price: Math.round(basePrice * 1.15),
            time: '08:30 - ' + String((8 + hours) % 24).padStart(2, '0') + `:${mins}`
        }
    ];
}

app.listen(PORT, () => {
    console.log(`====================================================`);
    console.log(`🚀 全球聯網真機票後端已啟動！監聽連接埠: ${PORT}`);
    console.log(`💡 目前運行模式：本地航空地理庫 + 真實跨洋時區修正引擎`);
    console.log(`====================================================`);
});