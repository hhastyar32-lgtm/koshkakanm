# کۆشکەکان — Marketplace

سایتێکی بازار بۆ **بەکرێدان و فرۆشتنی کۆشک، مەزرەعە و باغ** لە هەولێر و سلێمانی.

## تایبەتمەندییەکان

- Register / Login بە Database
- دوو شار: هەولێر و سلێمانی
- جۆرەکانی: کۆشک، مەزرەعە، باغ
- بەکرێدان بە نرخی ڕۆژانە
- فرۆشتن بە نرخی کۆیی
- گەڕان و فلتەر بەپێی شار، جۆر، مەبەست و نرخ
- زیادکردنی لیست لەلایەن خاوەن
- پەسەندکردنی لیست لەلایەن Admin
- داواکاری حجز
- داواکاری کڕین
- داشبۆردی خاوەن
- داشبۆردی Admin
- هەژمارکردنی کۆی داهات و کۆمسیۆنی سایت
- Favorites
- SQLite Database
- Session authentication
- Helmet و rate limit
- Responsive بۆ مۆبایل

## دامەزراندن

```bash
npm install
npm start
```

پاشان:
`http://localhost:3000`

## Admin

بۆ دروستکردنی Admin، لە Environment Variables ئەمانە دابنێ:

`ADMIN_EMAIL=admin@example.com`
`ADMIN_PASSWORD=ChangeThisPassword`

لە یەکەم run ـدا ئەگەر ئەو هەژمارە نەبێت، دروست دەکرێت.

## Render

ئەم پڕۆژەیە `render.yaml` ـی هەیە. SQLite لە `/var/data/koshkakan.db` دادەنرێت بۆ ئەوەی لەگەڵ Persistent Disk کار بکات.

## گرنگ

پارەدان بە کارت/فاستپی/کی پارەدان لەم وەشانەدا بە شێوەی ڕاستەوخۆ نەبەستراوە. سیستەمەکە transaction و commission ـەکان هەژمار دەکات و شوێنی payment gateway دواتر ئامادەیە بۆ زیادکردن.
