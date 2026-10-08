const express = require("express");
const path = require("path");
const fs = require("fs");
const bcrypt = require("bcryptjs");
const Database = require("better-sqlite3");
const helmet = require("helmet");
const rateLimit = require("express-rate-limit");
const crypto = require("crypto");

const app = express();
const PORT = process.env.PORT || 3000;
const DB_PATH = process.env.DATABASE_PATH || path.join(__dirname, "data", "koshkakan.db");
const UPLOAD_DIR = process.env.UPLOAD_DIR || path.join(path.dirname(DB_PATH), "uploads");
const ADMIN_EMAIL = process.env.ADMIN_EMAIL || "admin@koshkakan.local";
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || "ChangeMe123!";

fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });
fs.mkdirSync(UPLOAD_DIR, { recursive: true });
const db = new Database(DB_PATH);
db.pragma("journal_mode = WAL");
db.pragma("foreign_keys = ON");

db.exec(`
CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  email TEXT NOT NULL UNIQUE COLLATE NOCASE,
  phone TEXT DEFAULT '',
  password_hash TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT 'user',
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS listings (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  owner_id INTEGER NOT NULL,
  title TEXT NOT NULL,
  purpose TEXT NOT NULL CHECK(purpose IN ('rent','sale','both')),
  type TEXT NOT NULL CHECK(type IN ('کۆشک','مەزرەعە','باغ')),
  city TEXT NOT NULL CHECK(city IN ('هەولێر','سلێمانی')),
  area TEXT DEFAULT '',
  address TEXT DEFAULT '',
  description TEXT DEFAULT '',
  guests INTEGER DEFAULT 1,
  bedrooms INTEGER DEFAULT 0,
  bathrooms INTEGER DEFAULT 0,
  rent_price INTEGER DEFAULT 0,
  sale_price INTEGER DEFAULT 0,
  phone TEXT DEFAULT '',
  images TEXT DEFAULT '[]',
  amenities TEXT DEFAULT '[]',
  status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','approved','rejected','sold','hidden')),
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY(owner_id) REFERENCES users(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS bookings (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  listing_id INTEGER NOT NULL,
  customer_id INTEGER NOT NULL,
  start_date TEXT NOT NULL,
  days INTEGER NOT NULL DEFAULT 1,
  guests INTEGER NOT NULL DEFAULT 1,
  note TEXT DEFAULT '',
  total INTEGER NOT NULL DEFAULT 0,
  commission INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','approved','rejected','cancelled','completed')),
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY(listing_id) REFERENCES listings(id) ON DELETE CASCADE,
  FOREIGN KEY(customer_id) REFERENCES users(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS purchase_requests (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  listing_id INTEGER NOT NULL,
  buyer_id INTEGER NOT NULL,
  offer_price INTEGER NOT NULL DEFAULT 0,
  note TEXT DEFAULT '',
  commission INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','accepted','rejected','cancelled','completed')),
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY(listing_id) REFERENCES listings(id) ON DELETE CASCADE,
  FOREIGN KEY(buyer_id) REFERENCES users(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS favorites (
  user_id INTEGER NOT NULL,
  listing_id INTEGER NOT NULL,
  PRIMARY KEY(user_id, listing_id),
  FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE,
  FOREIGN KEY(listing_id) REFERENCES listings(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS auth_sessions (
  token TEXT PRIMARY KEY,
  user_id INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE
);
`);

function ensureAdmin() {
  const existing = db.prepare("SELECT id FROM users WHERE email = ?").get(ADMIN_EMAIL);
  if (!existing) {
    const hash = bcrypt.hashSync(ADMIN_PASSWORD, 12);
    db.prepare("INSERT INTO users (name,email,password_hash,role) VALUES (?,?,?,?)")
      .run("بەڕێوەبەر", ADMIN_EMAIL, hash, "admin");
    console.log(`Admin created: ${ADMIN_EMAIL}`);
  }
}
ensureAdmin();

app.disable("x-powered-by");
app.use(helmet({ contentSecurityPolicy: false }));
app.use(express.json({ limit: "25mb" }));
app.use(express.urlencoded({ extended: true }));
app.use(rateLimit({ windowMs: 60 * 1000, limit: 180, standardHeaders: true, legacyHeaders: false }));
app.use(express.static(path.join(__dirname, "public")));
app.use("/uploads", express.static(UPLOAD_DIR, { maxAge: "30d", immutable: true }));

function newSession(user) {
  const token = crypto.randomBytes(32).toString("hex");
  const expires = Date.now() + 30 * 24 * 3600 * 1000;
  db.prepare("INSERT INTO auth_sessions(token,user_id,expires_at) VALUES(?,?,?)").run(token, user.id, expires);
  db.prepare("DELETE FROM auth_sessions WHERE expires_at < ?").run(Date.now());
  return token;
}
function auth(req, res, next) {
  const token = (req.headers.authorization || "").replace(/^Bearer\s+/i, "");
  const s = db.prepare("SELECT user_id,expires_at FROM auth_sessions WHERE token=?").get(token);
  if (!s || s.expires_at < Date.now()) {
    if (token) db.prepare("DELETE FROM auth_sessions WHERE token=?").run(token);
    return res.status(401).json({ error: "پێویستە بچیتە ژوورەوە." });
  }
  const user = db.prepare("SELECT id,name,email,phone,role FROM users WHERE id=?").get(s.user_id);
  if (!user) return res.status(401).json({ error: "هەژمار نەدۆزرایەوە." });
  req.user = user;
  req.token = token;
  next();
}
function admin(req,res,next) {
  if (req.user.role !== "admin") return res.status(403).json({ error: "دەسەڵاتی بەڕێوەبەر پێویستە." });
  next();
}
function commissionFor(amount) {
  return Math.round(Math.max(0, Number(amount) || 0) * 0.05);
}
function parseListing(row, favorite = false) {
  return {
    ...row,
    images: JSON.parse(row.images || "[]"),
    amenities: JSON.parse(row.amenities || "[]"),
    favorite: !!favorite
  };
}

function saveImages(images, listingId) {
  if (!Array.isArray(images)) return [];
  const selected = images.slice(0, 8);
  const saved = [];
  for (let i = 0; i < selected.length; i++) {
    const src = String(selected[i] || "");
    const match = src.match(/^data:image\/(jpeg|jpg|png|webp);base64,([A-Za-z0-9+/=]+)$/i);
    if (!match) {
      if (/^https?:\/\//i.test(src) || src.startsWith("/uploads/")) { saved.push(src); continue; }
      throw new Error("فۆرماتی وێنەکە پشتگیری ناکرێت.");
    }
    const ext = match[1].toLowerCase() === "jpg" ? "jpg" : match[1].toLowerCase();
    const buffer = Buffer.from(match[2], "base64");
    if (buffer.length > 6 * 1024 * 1024) throw new Error("قەبارەی وێنە زۆر گەورەیە.");
    const name = `${listingId}-${i}-${crypto.randomBytes(8).toString("hex")}.${ext}`;
    fs.writeFileSync(path.join(UPLOAD_DIR, name), buffer);
    saved.push(`/uploads/${name}`);
  }
  return saved;
}

function removeListingImages(images) {
  for (const src of (Array.isArray(images) ? images : [])) {
    if (!String(src).startsWith("/uploads/")) continue;
    const name = path.basename(String(src));
    const file = path.join(UPLOAD_DIR, name);
    try { if (fs.existsSync(file)) fs.unlinkSync(file); } catch {}
  }
}

app.get("/api/me", auth, (req,res)=>res.json({user:req.user}));

app.post("/api/auth/register", async (req,res)=>{
  try {
    const {name,email,phone="",password} = req.body;
    if (!name || !email || !password) return res.status(400).json({error:"ناو، ئیمەیڵ و وشەی نهێنی پێویستن."});
    if (password.length < 6) return res.status(400).json({error:"وشەی نهێنی دەبێت لانیکەم 6 پیت بێت."});
    const exists = db.prepare("SELECT id FROM users WHERE email=?").get(email.trim());
    if (exists) return res.status(409).json({error:"ئەم ئیمەیڵە پێشتر بەکارهاتووە."});
    const hash = await bcrypt.hash(password,12);
    const r = db.prepare("INSERT INTO users(name,email,phone,password_hash) VALUES(?,?,?,?)")
      .run(name.trim(), email.trim(), phone.trim(), hash);
    const user = db.prepare("SELECT id,name,email,phone,role FROM users WHERE id=?").get(r.lastInsertRowid);
    res.json({user, token:newSession(user)});
  } catch(e) { res.status(500).json({error:"نەتوانرا هەژمار دروست بکرێت."}); }
});

app.post("/api/auth/login", async (req,res)=>{
  const {email,password} = req.body;
  const row = db.prepare("SELECT * FROM users WHERE email=?").get(String(email||"").trim());
  if (!row || !(await bcrypt.compare(String(password||""), row.password_hash)))
    return res.status(401).json({error:"ئیمەیڵ یان وشەی نهێنی هەڵەیە."});
  const user = {id:row.id,name:row.name,email:row.email,phone:row.phone,role:row.role};
  res.json({user, token:newSession(user)});
});

app.post("/api/auth/logout", auth, (req,res)=>{ db.prepare("DELETE FROM auth_sessions WHERE token=?").run(req.token); res.json({ok:true}); });

app.get("/api/listings", (req,res)=>{
  const {city="",type="",purpose="",q="",min=0,max=0,sort="newest",owner=""} = req.query;
  let sql = `SELECT l.*, u.name owner_name FROM listings l JOIN users u ON u.id=l.owner_id WHERE l.status='approved'`;
  const args=[];
  if(city){sql+=" AND l.city=?";args.push(city)}
  if(type){sql+=" AND l.type=?";args.push(type)}
  if(purpose){sql+=" AND (l.purpose=? OR l.purpose='both')";args.push(purpose)}
  if(q){sql+=" AND (l.title LIKE ? OR l.city LIKE ? OR l.area LIKE ? OR l.description LIKE ?)"; const x="%"+q+"%";args.push(x,x,x,x)}
  if(Number(min)>0){sql+=" AND (l.rent_price>=? OR l.sale_price>=?)";args.push(Number(min),Number(min))}
  if(Number(max)>0){sql+=" AND ((l.rent_price>0 AND l.rent_price<=?) OR (l.sale_price>0 AND l.sale_price<=?))";args.push(Number(max),Number(max))}
  if(owner){sql+=" AND l.owner_id=?";args.push(Number(owner))}
  sql += sort==="price_asc" ? " ORDER BY COALESCE(NULLIF(rent_price,0),sale_price) ASC" :
         sort==="price_desc" ? " ORDER BY COALESCE(NULLIF(rent_price,0),sale_price) DESC" :
         " ORDER BY l.id DESC";
  sql += " LIMIT 100";
  const rows=db.prepare(sql).all(...args);
  res.json(rows.map(r=>parseListing(r,false)));
});

app.get("/api/listings/:id", (req,res)=>{
  const row=db.prepare("SELECT l.*,u.name owner_name,u.phone owner_phone FROM listings l JOIN users u ON u.id=l.owner_id WHERE l.id=?").get(req.params.id);
  if(!row) return res.status(404).json({error:"لیست نەدۆزرایەوە."});
  if(row.status!=="approved") return res.status(404).json({error:"ئەم لیستە بەردەست نییە."});
  res.json(parseListing(row,false));
});

app.post("/api/listings", auth, (req,res)=>{
  const b=req.body;
  if(!b.title || !["هەولێر","سلێمانی"].includes(b.city) || !["کۆشک","مەزرەعە","باغ"].includes(b.type))
    return res.status(400).json({error:"ناونیشان، شار و جۆری دروست پێویستن."});
  if(!["rent","sale","both"].includes(b.purpose)) return res.status(400).json({error:"مەبەستی لیست هەڵەیە."});
  const rent=Number(b.rent_price)||0, sale=Number(b.sale_price)||0;
  if((b.purpose==="rent"||b.purpose==="both") && rent<=0) return res.status(400).json({error:"نرخی بەکرێدان دابین بکە."});
  if((b.purpose==="sale"||b.purpose==="both") && sale<=0) return res.status(400).json({error:"نرخی فرۆشتن دابین بکە."});
  let imageFiles = [];
  try {
    // وێنەکان لە خودی سرڤەر/وۆڵیومی Railway هەڵدەگیرێن؛ هیچ Cloudinary پێویست نییە.
    const nextId = Number(db.prepare("SELECT COALESCE(MAX(id),0)+1 AS id FROM listings").get().id);
    imageFiles = saveImages(b.images, nextId);
    const r=db.prepare(`INSERT INTO listings
      (owner_id,title,purpose,type,city,area,address,description,guests,bedrooms,bathrooms,rent_price,sale_price,phone,images,amenities)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
        req.user.id,String(b.title).trim(),b.purpose,b.type,b.city,b.area||"",b.address||"",b.description||"",
        Number(b.guests)||1,Number(b.bedrooms)||0,Number(b.bathrooms)||0,rent,sale,b.phone||req.user.phone||"",
        JSON.stringify(imageFiles),
        JSON.stringify(Array.isArray(b.amenities)?b.amenities.slice(0,20):[])
      );
    res.json({ok:true,id:r.lastInsertRowid,message:"لیستەکە نێردرا بۆ پەسەندکردنی بەڕێوەبەر."});
  } catch (e) {
    removeListingImages(imageFiles);
    res.status(400).json({error:e.message || "نەتوانرا وێنەکان هەڵبگیرێن."});
  }
});

app.get("/api/my/listings", auth, (req,res)=>{
  const rows=db.prepare("SELECT l.*,u.name owner_name FROM listings l JOIN users u ON u.id=l.owner_id WHERE l.owner_id=? ORDER BY l.id DESC").all(req.user.id);
  res.json(rows.map(r=>parseListing(r)));
});

app.delete("/api/listings/:id", auth, (req,res)=>{
  const row=db.prepare("SELECT * FROM listings WHERE id=?").get(req.params.id);
  if(!row) return res.status(404).json({error:"لیست نەدۆزرایەوە."});
  if(row.owner_id!==req.user.id && req.user.role!=="admin") return res.status(403).json({error:"دەسەڵاتت نییە."});
  removeListingImages(JSON.parse(row.images || "[]"));
  db.prepare("DELETE FROM listings WHERE id=?").run(req.params.id);
  res.json({ok:true});
});

app.post("/api/listings/:id/booking", auth, (req,res)=>{
  const l=db.prepare("SELECT * FROM listings WHERE id=? AND status='approved'").get(req.params.id);
  if(!l) return res.status(404).json({error:"لیست نەدۆزرایەوە."});
  if(!["rent","both"].includes(l.purpose)) return res.status(400).json({error:"ئەم شوێنە بۆ بەکرێدان نییە."});
  const days=Math.max(1,Number(req.body.days)||1), guests=Math.max(1,Number(req.body.guests)||1);
  if(l.guests && guests>l.guests) return res.status(400).json({error:`ئەم شوێنە تا ${l.guests} کەسە.`});
  const total=l.rent_price*days;
  const commission=commissionFor(total);
  const r=db.prepare(`INSERT INTO bookings(listing_id,customer_id,start_date,days,guests,note,total,commission)
    VALUES(?,?,?,?,?,?,?,?)`).run(l.id,req.user.id,req.body.start_date||"",days,guests,req.body.note||"",total,commission);
  res.json({ok:true,id:r.lastInsertRowid,total,commission,message:"داواکاری حجز نێردرا."});
});

app.post("/api/listings/:id/purchase", auth, (req,res)=>{
  const l=db.prepare("SELECT * FROM listings WHERE id=? AND status='approved'").get(req.params.id);
  if(!l) return res.status(404).json({error:"لیست نەدۆزرایەوە."});
  if(!["sale","both"].includes(l.purpose)) return res.status(400).json({error:"ئەم شوێنە بۆ فرۆشتن نییە."});
  const offer=Number(req.body.offer_price)||l.sale_price;
  if(offer<=0) return res.status(400).json({error:"نرخی پێشنیار پێویستە."});
  const commission=commissionFor(offer);
  const r=db.prepare(`INSERT INTO purchase_requests(listing_id,buyer_id,offer_price,note,commission)
    VALUES(?,?,?,?,?)`).run(l.id,req.user.id,offer,req.body.note||"",commission);
  res.json({ok:true,id:r.lastInsertRowid,commission,message:"داواکاری کڕین نێردرا."});
});

app.post("/api/favorites/:id", auth, (req,res)=>{
  const found=db.prepare("SELECT 1 FROM favorites WHERE user_id=? AND listing_id=?").get(req.user.id,req.params.id);
  if(found) db.prepare("DELETE FROM favorites WHERE user_id=? AND listing_id=?").run(req.user.id,req.params.id);
  else db.prepare("INSERT OR IGNORE INTO favorites(user_id,listing_id) VALUES(?,?)").run(req.user.id,req.params.id);
  res.json({favorite:!found});
});

app.get("/api/favorites", auth, (req,res)=>{
  const rows=db.prepare(`SELECT l.*,u.name owner_name FROM favorites f JOIN listings l ON l.id=f.listing_id JOIN users u ON u.id=l.owner_id WHERE f.user_id=? AND l.status='approved' ORDER BY f.rowid DESC`).all(req.user.id);
  res.json(rows.map(r=>parseListing(r,true)));
});

app.get("/api/owner/bookings", auth, (req,res)=>{
  const rows=db.prepare(`SELECT b.*,l.title,l.city,u.name customer_name,u.email customer_email,u.phone customer_phone
    FROM bookings b JOIN listings l ON l.id=b.listing_id JOIN users u ON u.id=b.customer_id
    WHERE l.owner_id=? ORDER BY b.id DESC`).all(req.user.id);
  res.json(rows);
});
app.post("/api/owner/bookings/:id/status", auth, (req,res)=>{
  const b=db.prepare(`SELECT b.* FROM bookings b JOIN listings l ON l.id=b.listing_id WHERE b.id=? AND l.owner_id=?`).get(req.params.id,req.user.id);
  if(!b)return res.status(404).json({error:"داواکاری نەدۆزرایەوە."});
  if(!["approved","rejected","completed","cancelled"].includes(req.body.status))return res.status(400).json({error:"status هەڵەیە."});
  db.prepare("UPDATE bookings SET status=? WHERE id=?").run(req.body.status,b.id);
  res.json({ok:true});
});
app.get("/api/owner/purchases", auth, (req,res)=>{
  res.json(db.prepare(`SELECT p.*,l.title,l.city,u.name buyer_name,u.email buyer_email,u.phone buyer_phone
    FROM purchase_requests p JOIN listings l ON l.id=p.listing_id JOIN users u ON u.id=p.buyer_id
    WHERE l.owner_id=? ORDER BY p.id DESC`).all(req.user.id));
});
app.post("/api/owner/purchases/:id/status", auth, (req,res)=>{
  const p=db.prepare(`SELECT p.*,l.owner_id,l.id listing_id FROM purchase_requests p JOIN listings l ON l.id=p.listing_id WHERE p.id=? AND l.owner_id=?`).get(req.params.id,req.user.id);
  if(!p)return res.status(404).json({error:"داواکاری نەدۆزرایەوە."});
  if(!["accepted","rejected","completed","cancelled"].includes(req.body.status))return res.status(400).json({error:"status هەڵەیە."});
  const tx=db.transaction(()=>{
    db.prepare("UPDATE purchase_requests SET status=? WHERE id=?").run(req.body.status,p.id);
    if(req.body.status==="completed") db.prepare("UPDATE listings SET status='sold' WHERE id=?").run(p.listing_id);
  });
  tx();res.json({ok:true});
});

app.get("/api/admin/stats", auth, admin, (req,res)=>{
  const users=db.prepare("SELECT COUNT(*) c FROM users WHERE role='user'").get().c;
  const listings=db.prepare("SELECT COUNT(*) c FROM listings").get().c;
  const approved=db.prepare("SELECT COUNT(*) c FROM listings WHERE status='approved'").get().c;
  const bookings=db.prepare("SELECT COUNT(*) c FROM bookings").get().c;
  const purchases=db.prepare("SELECT COUNT(*) c FROM purchase_requests").get().c;
  const rentRevenue=db.prepare("SELECT COALESCE(SUM(total),0) s FROM bookings WHERE status IN ('approved','completed')").get().s;
  const saleRevenue=db.prepare("SELECT COALESCE(SUM(offer_price),0) s FROM purchase_requests WHERE status IN ('accepted','completed')").get().s;
  const commission=db.prepare("SELECT COALESCE(SUM(commission),0) s FROM bookings WHERE status IN ('approved','completed')").get().s
    +db.prepare("SELECT COALESCE(SUM(commission),0) s FROM purchase_requests WHERE status IN ('accepted','completed')").get().s;
  res.json({users,listings,approved,bookings,purchases,rentRevenue,saleRevenue,commission});
});
app.get("/api/admin/listings", auth, admin, (req,res)=>{
  const rows=db.prepare(`SELECT l.*,u.name owner_name,u.email owner_email FROM listings l JOIN users u ON u.id=l.owner_id ORDER BY l.id DESC`).all();
  res.json(rows.map(r=>parseListing(r)));
});
app.post("/api/admin/listings/:id/status", auth, admin, (req,res)=>{
  if(!["approved","rejected","hidden"].includes(req.body.status))return res.status(400).json({error:"status هەڵەیە."});
  const r=db.prepare("UPDATE listings SET status=? WHERE id=?").run(req.body.status,req.params.id);
  if(!r.changes)return res.status(404).json({error:"لیست نەدۆزرایەوە."});
  res.json({ok:true});
});
app.get("/api/admin/bookings", auth, admin, (req,res)=>{
  res.json(db.prepare(`SELECT b.*,l.title,l.city,u.name customer_name,ow.name owner_name
    FROM bookings b JOIN listings l ON l.id=b.listing_id JOIN users u ON u.id=b.customer_id JOIN users ow ON ow.id=l.owner_id
    ORDER BY b.id DESC LIMIT 300`).all());
});
app.get("/api/admin/purchases", auth, admin, (req,res)=>{
  res.json(db.prepare(`SELECT p.*,l.title,l.city,u.name buyer_name,ow.name owner_name
    FROM purchase_requests p JOIN listings l ON l.id=p.listing_id JOIN users u ON u.id=p.buyer_id JOIN users ow ON ow.id=l.owner_id
    ORDER BY p.id DESC LIMIT 300`).all());
});

app.get("*",(req,res)=>{
  res.sendFile(path.join(__dirname,"public","index.html"));
});

app.listen(PORT,()=>console.log(`Koshkakan running on http://localhost:${PORT}`));
