const express = require('express');
const cors = require('cors');
const admin = require('firebase-admin');
const fs = require('fs');
const path = require('path');
const puppeteer = require('puppeteer');
const handlebars = require('handlebars');
const QRCode = require('qrcode');
const ExcelJS = require('exceljs');
const { PDFDocument } = require('pdf-lib');
const { createCanvas, loadImage } = require('canvas');
const APP_URL = "https://eoffice-mij-v3-production.up.railway.app";

// GANTI BAGIAN INISIALISASI FIREBASE LAMA DENGAN INI:
try {
    let serviceAccount;
    // Jika di Railway (Production), pakai Environment Variable
    if (process.env.FIREBASE_CREDENTIALS) {
        serviceAccount = JSON.parse(process.env.FIREBASE_CREDENTIALS);
    } else {
        // Jika di Localhost, pakai file json
        serviceAccount = require('./serviceAccountKey.json');
    }

    admin.initializeApp({ credential: admin.credential.cert(serviceAccount) });
} catch (e) { console.error("❌ Firebase Auth Error:", e.message); }
const db = admin.firestore();

const app = express();
app.use(cors());
app.use(express.json({ limit: '50mb' })); 
app.use(express.urlencoded({ limit: '50mb', extended: true }));

// === HELPER UTAMA ===
const toRoman = (n) => ["","I","II","III","IV","V","VI","VII","VIII","IX","X","XI","XII"][n] || "";
const getFiscalYear = (d) => d.getMonth()+1 >= 7 ? `${d.getFullYear()}/${d.getFullYear()+1}` : `${d.getFullYear()-1}/${d.getFullYear()}`;

// --- FUNGSI TANGGAL BARU (FIX: MENAMBAHKAN toHijri) ---

// 1. Fungsi Inti Konversi Hijriyah
function toHijri(date) {
    // Menggunakan Intl API untuk mendapatkan komponen tanggal Hijriyah
    const formatter = new Intl.DateTimeFormat('en-US-u-ca-islamic-umalqura', {
        day: 'numeric',
        month: 'numeric',
        year: 'numeric'
    });
    const parts = formatter.formatToParts(date);
    const day = parts.find(p => p.type === 'day').value;
    const month = parseInt(parts.find(p => p.type === 'month').value);
    const year = parts.find(p => p.type === 'year').value;
    return { day, month, year };
}

// 2. Memecah Masehi (Untuk Rata Kiri-Kanan)
function getMasehiParts(date) {
    const months = ["Januari", "Februari", "Maret", "April", "Mei", "Juni", "Juli", "Agustus", "September", "Oktober", "November", "Desember"];
    return {
        dateStr: `${date.getDate()} ${months[date.getMonth()]}`,
        yearStr: `${date.getFullYear()} M`
    };
}

// 3. Memecah Hijriyah (Untuk Rata Kiri-Kanan)
function getHijriParts(date) {
    const h = toHijri(date);
    const months = ["Muharram", "Safar", "Rabi’ul Awal", "Rabi’ul Akhir", "Jumadil Awal", "Jumadil Akhir", "Rajab", "Sya’ban", "Ramadhan", "Syawal", "Dzulqa’dah", "Dzulhijjah"];
    // month - 1 karena array mulai dari 0
    const monthName = months[(h.month - 1)] || months[0];
    return {
        dateStr: `${h.day} ${monthName}`,
        yearStr: `${h.year} H`
    };
}

const getMasehiDate = (d) => `${d.toLocaleDateString('id-ID', { day: 'numeric', month: 'long', year: 'numeric' })} M`;
const getHijriOnly = (d) => {
    const parts = getHijriParts(d);
    return `${parts.dateStr} ${parts.yearStr}`;
};

// --- HELPER LAINNYA ---
function constructName(userData) {
    if (!userData) return 'Unknown';
    const p = userData.profile || userData; 
    const gelarDepan = p.gelar_depan || p.GELAR_DEPAN || '';
    const nama = p.full_name || p.nama || p.NAMA || '';
    const gelarBelakang = p.gelar_belakang || p.GELAR_BELAKANG || '';
    return `${gelarDepan} ${nama} ${gelarBelakang}`.trim().replace(/\s+/g, ' ');
}
function getJobTitle(userData) {
    const p = userData?.profile || userData || {};
    return p.jabatan_struktural || p.JABATAN_STRUKTURAL || 'Staff';
}
const imgToBase64 = (relativePath) => {
    try {
        const absolutePath = path.resolve(__dirname, relativePath);
        if (!fs.existsSync(absolutePath)) return null;
        return `data:image/png;base64,${fs.readFileSync(absolutePath).toString('base64')}`;
    } catch (e) { return null; }
};

// === FUNGSI STAMPING ===
async function stampPDF(originalPdfBase64, stampData) {
    const cleanBase64 = (str) => {
        if (!str || typeof str !== 'string') return null;
        return str.replace(/^data:.*,/, "").trim();
    };

    try {
        const { nomor_surat, qr_data, locations, lampiran, render_width } = stampData;
        const mainPdfStr = cleanBase64(originalPdfBase64);
        if (!mainPdfStr) throw new Error("File PDF Utama Kosong/Corrupt");

        const pdfBuffer = Buffer.from(mainPdfStr, 'base64');
        const pdfDoc = await PDFDocument.load(pdfBuffer);
        const pages = pdfDoc.getPages();

        let qrImage = null;
        if (qr_data) {
            try {
                const canvasSize = 300; 
                const canvas = createCanvas(canvasSize, canvasSize);
                await QRCode.toCanvas(canvas, qr_data, { width: canvasSize, margin: 1, errorCorrectionLevel: 'H' });
                const logoPath = path.resolve(__dirname, 'src/assets/logo-mij.png');
                if (fs.existsSync(logoPath)) {
                    const ctx = canvas.getContext('2d');
                    const logoImg = await loadImage(logoPath);
                    const logoSize = canvasSize * 0.23;
                    const logoPos = (canvasSize - logoSize) / 2;
                    ctx.fillStyle = '#ffffff';
                    ctx.fillRect(logoPos - 3, logoPos - 3, logoSize + 6, logoSize + 6);
                    ctx.drawImage(logoImg, logoPos, logoPos, logoSize, logoSize);
                }
                qrImage = await pdfDoc.embedPng(canvas.toBuffer());
            } catch (qrErr) { console.error("QR Error:", qrErr); }
        }

        if (locations && Array.isArray(locations)) {
            for (const loc of locations) {
                try {
                    const pageIdx = parseInt(loc.pageIndex);
                    if (isNaN(pageIdx) || pageIdx < 0 || pageIdx >= pages.length) continue;
                    
                    const page = pages[pageIdx];
                    const { width: pageWidth, height: pageHeight } = page.getSize();
                    const safeWidth = (parseFloat(render_width) > 50) ? parseFloat(render_width) : 600; 
                    const scale = pageWidth / safeWidth;

                    const finalW = (parseFloat(loc.w) || 80) * scale;
                    const finalH = (parseFloat(loc.h) || 80) * scale;
                    const finalX = (parseFloat(loc.x) || 0) * scale;
                    const finalY = pageHeight - ((parseFloat(loc.y) || 0) * scale) - finalH; 

                    if (!Number.isFinite(finalX) || !Number.isFinite(finalY) || !Number.isFinite(finalW) || !Number.isFinite(finalH)) continue;

                    if (loc.type === 'qr' && qrImage) {
                        page.drawImage(qrImage, { x: finalX, y: finalY, width: finalW, height: finalH });
                    } else if (loc.type === 'nomor') {
                        let fontSize = Math.floor(finalH * 0.65);
                        if(fontSize < 8) fontSize = 8;
                        const font = await pdfDoc.embedFont('Helvetica-Bold');
                        page.drawText(String(nomor_surat || '-'), {
                            x: finalX, y: finalY + (finalH * 0.2), size: fontSize, font: font, color: { type: 'RGB', red: 0, green: 0, blue: 0 },
                        });
                    }
                } catch (errStamp) { console.error("Skip stamp:", errStamp.message); }
            }
        }

        if (lampiran && Array.isArray(lampiran)) {
            for (const att of lampiran) {
                try {
                    let rawAtt = (typeof att === 'object' && att?.data) ? att.data : att;
                    const cleanAtt = cleanBase64(rawAtt);
                    if (!cleanAtt) continue;
                    const attBuffer = Buffer.from(cleanAtt, 'base64');
                    if (attBuffer.toString('utf8', 0, 4) !== '%PDF') continue; 
                    const attPdf = await PDFDocument.load(attBuffer);
                    const copiedPages = await pdfDoc.copyPages(attPdf, attPdf.getPageIndices());
                    copiedPages.forEach((p) => pdfDoc.addPage(p));
                } catch (e) { }
            }
        }
        return Buffer.from(await pdfDoc.save());
    } catch (e) { 
        console.error("STAMP CRASH:", e); 
        throw new Error("Gagal memproses PDF: " + e.message);
    }
}

// === CORE PDF GENERATOR (REVISI CSS: TABLE & SPACING) ===
async function createPDFBuffer(data) {
    // 1. Jika Mode Upload (Skip, logika sama)
    if (data.mode_buat === 'upload' && data.uploaded_file_base64) {
        return await stampPDF(data.uploaded_file_base64, {
            nomor_surat: data.status_global === 'APPROVED' ? data.nomor_surat : "Draft/......../........",
            qr_data: data.status_global === 'APPROVED' ? `${APP_URL}/verify/${data.id_surat}` : 'PREVIEW_QR',
            locations: data.stamp_locations || [],
            lampiran: data.lampiran || [],
            render_width: data.render_width || 600
        });
    }

    // 2. Mode Web Editor
    try {
        const kop = imgToBase64('src/assets/Kop_Surat_Resmi.png');
        const foot = imgToBase64('src/assets/Footer_Surat.png');
        const isApproved = data.status_global === 'APPROVED';

        // --- Persiapan Data ---
        let qrBase64 = null;
        if (isApproved) {
            const info = `${APP_URL}/verify/${data.id_surat}`;
            qrBase64 = await QRCode.toDataURL(info, { width: 120, margin: 1, errorCorrectionLevel: 'H' });
        }

        let dateSrc = new Date();
        if (isApproved && data.approver?.ttd_date) dateSrc = new Date(data.approver.ttd_date._seconds * 1000);
        const tglMasehiParts = getMasehiParts(dateSrc);
        const tglHijriParts = getHijriParts(dateSrc);

        const nomorSurat = isApproved ? data.nomor_surat : "Draft/......../........";
        const lampiranText = (data.lampiran && data.lampiran.length > 0) ? "1 (satu) Berkas" : "-";
        
        let tembusanHtml = '';
        if (data.tembusan && data.tembusan.length > 0) {
            tembusanHtml = `
            <div style="margin-top: 7em; font-size: inherit;">
                <b style="text-decoration: underline;">Tembusan:</b>
                <ol style="margin-top: 0.2em; padding-left: 20px; margin-bottom: 0;">
                    ${data.tembusan.map(t => `<li style="padding-left: 5px;">${t}</li>`).join('')}
                </ol>
            </div>`;
        }

        let ttdVisual = isApproved && qrBase64 
            ? `<img src="${qrBase64}" style="width: 80px; height: 80px;">` 
            : `<div style="width: 100px; height: 60px; border: 2px dashed #999; display: flex; align-items: center; justify-content: center; color: #999; font-size: 0.8em; font-weight: bold;">DRAFT TTD</div>`;

        // --- HTML & CSS PERBAIKAN ---
        const htmlContent = `<!DOCTYPE html>
        <html>
        <head>
            <style>
                /* 1. GLOBAL RESET (Mencegah Font Berantakan) */
                * {
                    font-family: 'Trebuchet MS', sans-serif !important;
                    box-sizing: border-box;
                }
                
                @page { size: 215mm 330mm; margin: 0; }

                body {
                    margin: 0; padding: 0;
                    font-size: 12pt; 
                    line-height: 1.35; /* AGAR TIDAK TERLALU RENGGANG */
                    color: #000;
                    background: #fff;
                }

                .page-content {
                    /* Padding Kiri/Kanan 25mm, Bawah 35mm (space footer) */
                    padding: 5px 25mm 35mm 25mm; 
                    position: relative;
                    z-index: 10;
                }

                .header-img { width: 100%; display: block; margin-bottom: 0; }
                .footer-img { position: fixed; bottom: 0; left: 0; width: 100%; z-index: -10; }

                /* 2. STYLE UNTUK ISI SURAT (Spacing Paragraf) */
                .content { 
                    text-align: justify; 
                    font-size: inherit; 
                    width: 100%; 
                }
                
                /* Reset heading/span dari editor agar tidak besar sendiri */
                .content h1, .content h2, .content h3, .content h4, .content span, .content div {
                    font-size: inherit !important;
                    font-weight: normal;
                    margin: 0;
                    line-height: inherit;
                }
                .content b, .content strong { font-weight: bold; }

                /* PERBAIKAN SPASI PARAGRAF */
                .content p { 
                    margin-top: 0;
                    margin-bottom: 0.6em; /* Jarak antar paragraf diperkecil (sebelumnya 1em) */
                    text-indent: 0px; 
                    line-height: inherit; 
                }
                .content ol, .content ul { margin: 0 0 0.6em 0; padding-left: 35px; }
                
                /* 3. PERBAIKAN TABEL (AGAR TITIK DUA TIDAK JAUH) */
                .content table { 
                    width: 100% !important; 
                    margin: 0.5em 0; 
                    border-collapse: collapse; 
                    font-size: inherit; 
                }
                .content table td { 
                    padding: 2px 4px; 
                    vertical-align: top; 
                    border: none; /* Default tanpa border untuk layout agenda */
                }
                
                /* TRIK CSS: Membatasi lebar kolom pertama (Label Hari/Tanggal) */
                /* Ini akan memaksa titik dua (:) mendekat ke kiri */
                .content table tr td:first-child {
                    width: 50px; /* Lebar fix untuk label */
                    white-space: nowrap; /* Jangan biarkan label turun baris */
                }
                /* Jika user pakai border di editor, class ini akan menangani */
                .content table[border="1"] td { border: 1px solid #000; }

                /* HEADER TANGGAL (Rata Kanan) */
                .date-table { float: right; border-collapse: collapse; margin-bottom: 0.5em; font-size: inherit; }
                .date-table td { padding: 0; vertical-align: top; text-align: right; font-size: inherit; }
                .hijri-row { border-bottom: 1px solid #000; padding-bottom: 0px; margin-bottom: 0px; display: inline-block; min-width: 120px; }

                /* META DATA (Nomor, Lampiran) */
                .meta-table { width: 100%; border-collapse: collapse; margin-bottom: 1.2em; font-size: inherit; }
                .meta-table td { vertical-align: top; padding: 0px 0; font-size: inherit; }

                /* TANDA TANGAN */
                .signature-wrapper { margin-top: 2em; page-break-inside: avoid; width: 100%; font-size: inherit; }
                .signature-table { width: 100%; border: none; font-size: inherit; }
                .ttd-col { text-align: center; padding-left: 10px; }
                .ttd-space { height: 5.5em; display: flex; align-items: center; justify-content: center; }

                .clearfix::after { content: ""; clear: both; display: table; }
            </style>
        </head>
        <body>
            <img src="${kop}" class="header-img">
            
            <div class="page-content">
                <div class="clearfix">
                    <table class="date-table">
                        <tr>
                            <td rowspan="2" style="padding-right: 10px; vertical-align: top;">Jakarta, </td>
                            <td>
                                <div class="hijri-row">
                                    <span style="float:left;">${tglHijriParts.dateStr}</span>
                                    <span style="float:right;">${tglHijriParts.yearStr}</span>
                                    <div style="clear:both;"></div>
                                </div>
                            </td>
                        </tr>
                        <tr>
                            <td>
                                <div style="min-width: 120px;">
                                    <span style="float:left;">${tglMasehiParts.dateStr}</span>
                                    <span style="float:right;">${tglMasehiParts.yearStr}</span>
                                    <div style="clear:both;"></div>
                                </div>
                            </td>
                        </tr>
                    </table>
                </div>

                <table class="meta-table">
                    <tr><td style="width:90px;">Nomor</td><td style="width:10px;">:</td><td>${nomorSurat}</td></tr>
                    <tr><td>Lampiran</td><td>:</td><td>${lampiranText}</td></tr>
                    <tr><td>Perihal</td><td>:</td><td style="font-weight:bold;">${data.perihal}</td></tr>
                </table>

                <div style="margin-bottom: 1.2em;">
                    Kepada Yth.<br/>
                    <b>${data.tujuan_jabatan||''}</b><br/>
                    ${data.tujuan_nama||''}<br/>
                    di Tempat
                </div>

                <div class="content">
                    ${data.isi_ringkas||''}
                </div>

                <div class="signature-wrapper">
                    <table class="signature-table">
                        <tr>
                            <td style="width:50%; vertical-align:top; padding-right:15px;">
                                ${tembusanHtml}
                            </td>
                            <td style="width:50%; vertical-align:top;">
                                <div class="ttd-col">
                                    <div>Hormat Kami,</div>
                                    <div style="font-weight:bold; margin-bottom:0.2em;">${data.approver?.jabatan||'Pejabat'}</div>
                                    <div class="ttd-space">${ttdVisual}</div>
                                    <div style="font-weight:bold; text-decoration:underline;">${data.approver?.nama||'Nama'}</div>
                                    <div>NIP. ${data.approver?.nip||'-'}</div>
                                </div>
                            </td>
                        </tr>
                    </table>
                </div>
            </div>
            
            <img src="${foot}" class="footer-img">
        </body>
        </html>`;

        const browser = await puppeteer.launch({ 
            headless: 'new', 
            args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage', '--disable-gpu'] 
        });
        const page = await browser.newPage();
        await page.setContent(htmlContent, { waitUntil: 'networkidle0' });

        // --- LOGIKA FIT TO PAGE (SMART RESIZE) ---
        await page.evaluate(() => {
            const body = document.body;
            // Tinggi Area Aman (F4 - Header - Footer - Margin Error)
            const MAX_HEIGHT = 1180; 
            
            let currentSize = 12; // Start 12pt
            const minSize = 9;    // Mentok 9pt

            const isOverflow = () => body.scrollHeight > MAX_HEIGHT;

            // Loop Resize
            while (isOverflow() && currentSize > minSize) {
                currentSize -= 0.5; // Turun per 0.5pt
                body.style.fontSize = currentSize + 'pt';

                // Tweak Line Height agar makin rapat saat font kecil
                if (currentSize < 10) {
                    body.style.lineHeight = '1.25';
                } else if (currentSize < 11) {
                    body.style.lineHeight = '1.3';
                } else {
                    body.style.lineHeight = '1.35';
                }
            }
        });

        const pdfBuffer = await page.pdf({ 
            width: '215mm', 
            height: '330mm', 
            printBackground: true, 
            margin: { top:0, right:0, bottom:0, left:0 } 
        });

        await browser.close();

        // Merge Lampiran (Jika ada)
        if (data.lampiran && data.lampiran.length > 0) {
            const mergedPdf = await PDFDocument.load(pdfBuffer);
            for (const att of data.lampiran) {
                try {
                    let raw = (typeof att === 'object' && att.data) ? att.data : att;
                    if (raw && raw.includes('base64,')) {
                         const attBuf = Buffer.from(raw.split('base64,')[1], 'base64');
                         const attPdf = await PDFDocument.load(attBuf);
                         const pages = await mergedPdf.copyPages(attPdf, attPdf.getPageIndices());
                         pages.forEach(p => mergedPdf.addPage(p));
                    }
                } catch(e) {}
            }
            return Buffer.from(await mergedPdf.save());
        }

        return Buffer.from(pdfBuffer);

    } catch (e) {
        console.error("CreatePDF Error:", e);
        throw e;
    }
}

// === ROUTES ===

app.post('/api/login', async (req, res) => {
    const { nip, password } = req.body;
    const doc = await db.collection('users').doc(nip).get();
    if (!doc.exists) return res.status(404).json({ msg: 'NIP Tidak Ditemukan' });
    const userData = doc.data();
    const dbPass = userData.password || 'Mij12345!'; 
    if (password !== dbPass) return res.status(401).json({ msg: 'Password Salah!' });
    res.json({ success: true, user: { ...userData, uid: nip, full_name_display: constructName(userData), job_display: getJobTitle(userData) } });
});

app.post('/api/change-password', async (req, res) => {
    const { nip, newPassword } = req.body;
    try {
        if (!newPassword || newPassword.length < 6) throw new Error("Password minimal 6 karakter");
        await db.collection('users').doc(nip).set({ password: newPassword }, { merge: true });
        res.json({ success: true });
    } catch (e) { res.status(400).json({ error: e.message }); }
});

app.get('/api/references', async (req, res) => {
    try {
        const nip = req.query.nip;
        let allUnitsRaw = [], typesRaw = [];
        try {
            allUnitsRaw = (await db.collection('units').get()).docs.map(d => d.data());
            typesRaw = (await db.collection('letter_types').get()).docs.map(d => d.data());
        } catch (err) {}
        const allUnits = allUnitsRaw.map(u => ({
            code: u.code || u['Kode Unit (ID)'] || u['Kode Unit'] || '',
            name: u.name || u['Nama Unit Lengkap'] || u['Nama Unit'] || '',
            ...u 
        })).filter(u => u.code);
        const types = typesRaw.map(t => ({
            id: t.id || t['Kode Tipe (ID Database)'] || t['Kode Tipe'] || '',
            name: t.name || t['Nama Tipe Surat (Untuk Dropdown)'] || t['Nama Tipe'] || '',
            format_code: t.format_code || t['Format Kode Penomoran'] || '',
            need_activity_code: t.need_activity_code || (String(t['Keterangan'] || '').toLowerCase().includes('kegiatan')),
            ...t
        })).filter(t => t.id);
        allUnits.sort((a, b) => (a.name || '').localeCompare(b.name || ''));
        types.sort((a, b) => (a.name || '').localeCompare(b.name || ''));
        let userData = null;
        if(nip) {
            const uDoc = await db.collection('users').doc(nip).get();
            if(uDoc.exists) userData = uDoc.data();
        }
        res.json({ units: allUnits, types: types, user_raw: userData });
    } catch(e) { res.status(500).json({error: e.message}); }
});

app.post('/api/preview-pdf', async (req, res) => {
    try {
        const { mode_buat, upload_data, approver_nip, ...sisaData } = req.body;
        
        // Mode Upload
        if (mode_buat === 'upload' && upload_data) {
            const previewPdf = await stampPDF(upload_data.file_base64, {
                nomor_surat: "Draft/Preview/...",
                // Pakai variabel APP_URL
                qr_data: `${APP_URL}/verify/PREVIEW`, 
                locations: upload_data.stamps,
                render_width: upload_data.render_width,
                lampiran: req.body.lampiran || []
            });
            res.set({'Content-Type':'application/pdf'}); 
            return res.send(previewPdf);
        }

        // Mode Web
        let approverData = {};
        if (approver_nip && typeof approver_nip === 'string' && approver_nip.trim() !== '') {
            try {
                const approverDoc = await db.collection('users').doc(approver_nip).get();
                if (approverDoc.exists) approverData = approverDoc.data();
            } catch(e) { console.log("Approver fetch skipped:", e.message); }
        }

        const mockData = {
            ...sisaData, 
            status_global: 'DRAFT',
            approver: { 
                nama: constructName(approverData) || "NAMA APPROVER", 
                jabatan: getJobTitle(approverData) || "JABATAN", 
                nip: approver_nip || "NIP. -"
            },
            id_surat: 'PREVIEW',
            isi_ringkas: sisaData.isi_surat || ''
        };
        const pdfBuffer = await createPDFBuffer(mockData);
        res.set({'Content-Type':'application/pdf'}); res.send(pdfBuffer);
    } catch (e) { 
        console.error("CRITICAL PREVIEW ERROR:", e);
        res.status(500).json({ error: "Gagal membuat preview: " + e.message }); 
    }
});

app.post('/api/letters', async (req, res) => {
    try {
        const { approver_nip, maker_nip, mode_buat, upload_data, id_surat, ...data } = req.body;
        if (!approver_nip) return res.status(400).json({ error: "NIP Penandatangan Kosong!" });
        
        const approverDoc = await db.collection('users').doc(approver_nip).get();
        const makerDoc = await db.collection('users').doc(maker_nip).get();
        const makerData = makerDoc.exists ? makerDoc.data() : {};
        const approverData = approverDoc.exists ? approverDoc.data() : {};

        let ref;
        let isUpdate = false;

        if (id_surat && id_surat !== 'null' && id_surat !== 'undefined') {
            const docCheck = await db.collection('letters').doc(id_surat).get();
            if (docCheck.exists) {
                ref = db.collection('letters').doc(id_surat);
                isUpdate = true;
            } else { ref = db.collection('letters').doc(); }
        } else { ref = db.collection('letters').doc(); }

        let letterData = {
            id_surat: ref.id,
            ...data,
            status_global: 'PROSES', 
            maker: { nip: maker_nip, unit: data.unit_kop, nama: constructName(makerData), jabatan: getJobTitle(makerData) },
            approver: { nip: approver_nip, nama: constructName(approverData), jabatan: getJobTitle(approverData), status: 'PENDING' },
            updated_at: admin.firestore.FieldValue.serverTimestamp(),
            mode_buat: mode_buat || 'web',
            revision_note: admin.firestore.FieldValue.delete()
        };

        if (!isUpdate) letterData.created_at = admin.firestore.FieldValue.serverTimestamp();

        if (mode_buat === 'upload') {
            letterData.uploaded_file_base64 = upload_data.file_base64;
            letterData.stamp_locations = upload_data.stamps;
            letterData.render_width = upload_data.render_width;
            letterData.isi_ringkas = "Dokumen Upload PDF (Lihat File Asli)";
        } else {
            letterData.isi_ringkas = data.isi_surat || '';
        }

        await ref.set(letterData, { merge: true });
        res.json({ success: true, id: ref.id });
    } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/my-letters', async (req, res) => {
    try {
        const nip = req.query.nip;
        let role = 'User', myUnit = '';
        try {
            const userDoc = await db.collection('users').doc(nip).get();
            if (userDoc.exists) {
                role = userDoc.data()?.system_role?.role_name || 'User';
                myUnit = userDoc.data()?.profile?.unit_homebase || '';
            }
        } catch (err) {}

        let query = db.collection('letters');
        if (role.includes('Super Admin Global')) {
            const snap = await query.orderBy('created_at', 'desc').get();
            const unique = Array.from(new Map(snap.docs.map(doc => [doc.id, doc.data()])).values());
            return res.json({ success: true, data: unique });
        } 
        
        const queryMe = db.collection('letters').where('maker.nip', '==', nip);
        const snapMe = await queryMe.get();
        let letters = snapMe.docs.map(d => d.data());

        if (role.includes('Super Admin Satdik') || role.includes('Super Admin Madrasah')) {
            if (myUnit) {
                const queryUnit = db.collection('letters').where('maker.unit', '==', myUnit);
                const snapUnit = await queryUnit.get();
                const unitLetters = snapUnit.docs.map(d => d.data());
                const combined = [...letters, ...unitLetters];
                const uniqueMap = new Map();
                combined.forEach(item => { if (!uniqueMap.has(item.id_surat)) uniqueMap.set(item.id_surat, item); });
                letters = Array.from(uniqueMap.values());
            }
        }
        letters.sort((a,b) => (b.created_at?._seconds || 0) - (a.created_at?._seconds || 0));
        res.json({ success: true, data: letters });
    } catch (e) { 
        if (e.message.includes('index')) return res.status(500).json({ error: "DB Index Required" });
        res.status(500).json({ error: e.message }); 
    }
});

app.get('/api/incoming-letters', async (req, res) => {
    try {
        const nip = req.query.nip;
        const type = req.query.type; 
        let query = db.collection('letters').where('approver.nip', '==', nip);
        const snap = await query.get();
        if (snap.empty) return res.json({ success: true, data: [] });

        let letters = snap.docs.map(d => d.data());
        if (type === 'history') {
            letters = letters.filter(l => ['APPROVED', 'REVISION'].includes(l.status_global));
        } else {
            letters = letters.filter(l => l.status_global === 'PROSES');
        }

        letters = await Promise.all(letters.map(async (l) => {
            if (!l.maker?.nama || l.maker.nama === 'Nama Tidak Tersedia' || l.maker.nama === 'Unknown') {
                const uDoc = await db.collection('users').doc(l.maker.nip).get();
                if (uDoc.exists) {
                    const uData = uDoc.data();
                    l.maker = { ...l.maker, nama: constructName(uData), jabatan: getJobTitle(uData) };
                }
            }
            return l;
        }));
        
        letters.sort((a,b) => (b.created_at?._seconds || 0) - (a.created_at?._seconds || 0));
        res.json({ success: true, data: letters });
    } catch (e) { 
        console.error("Incoming Error:", e);
        res.status(500).json({ error: e.message }); 
    }
});

app.get('/api/export-excel', async (req, res) => {
    try {
        const { start, end } = req.query;
        let query = db.collection('letters');
        if (start && end) {
            const startDate = new Date(start); startDate.setHours(0,0,0);
            const endDate = new Date(end); endDate.setHours(23,59,59);
            query = query.where('created_at', '>=', startDate).where('created_at', '<=', endDate);
        }
        const snap = await query.get();
        const letters = snap.docs.map(d => d.data());
        const workbook = new ExcelJS.Workbook();
        const sheet = workbook.addWorksheet('Rekap Surat');
        sheet.columns = [
            { header: 'No', key: 'idx', width: 5 }, { header: 'Tanggal', key: 'date', width: 15 },
            { header: 'Unit', key: 'unit', width: 10 }, { header: 'Nomor', key: 'nomor', width: 25 },
            { header: 'Perihal', key: 'perihal', width: 40 }, { header: 'Maker', key: 'maker', width: 30 },
            { header: 'Approver', key: 'approver', width: 30 }, { header: 'Status', key: 'status', width: 15 },
        ];
        letters.forEach((l, i) => {
            const tgl = l.created_at ? new Date(l.created_at._seconds * 1000).toLocaleDateString('id-ID') : '-';
            sheet.addRow({ idx: i + 1, date: tgl, unit: l.maker?.unit || '-', nomor: l.nomor_surat || '-', perihal: l.perihal, maker: l.maker?.nama, approver: l.approver?.nama, status: l.status_global });
        });
        res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
        res.setHeader('Content-Disposition', 'attachment; filename=Rekap.xlsx');
        await workbook.xlsx.write(res);
        res.end();
    } catch (e) { res.status(500).send(e.message); }
});

app.post('/api/reject', async (req, res) => {
    const { id_surat, note } = req.body;
    try {
        await db.collection('letters').doc(id_surat).update({ status_global: 'REVISION', 'approver.status': 'REVISION', revision_note: note });
        res.json({ success: true });
    } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/approve', async (req, res) => {
    const { id_surat } = req.body;
    try {
        const ref = db.collection('letters').doc(id_surat);
        const doc = await ref.get();
        if(!doc.exists) throw new Error("Surat tidak ditemukan");
        const data = doc.data();
        const now = new Date();
        const fiscal = getFiscalYear(now);
        const counterId = `count_${data.unit_kop}_${fiscal.replace('/','-')}`;
        const counterRef = db.collection('counters').doc(counterId);
        let finalNomor = '';
        await db.runTransaction(async (t) => {
            const cDoc = await t.get(counterRef);
            let nextNo = 1;
            if (cDoc.exists) nextNo = cDoc.data().last_number + 1;
            t.set(counterRef, { last_number: nextNo }, { merge: true });
            
            const typeDoc = await db.collection('letter_types').doc(data.tipe_surat).get();
            let format = "NOCODE";
            if(typeDoc.exists) {
                const td = typeDoc.data();
                format = td.format || td.format_code;
                // Jika tipe surat butuh kegiatan, timpa format dengan kode kegiatan (jika ada)
                if(td.need_activity || td.need_activity_code) format = `Pan.${data.kode_kegiatan}`;
            } else if (data.tipe_surat === 'manual') { 
                format = data.manual_kode; 
            }

            // === REVISI LOGIKA PANITIA ===
            // Jika user mengisi Kode Panitia manual, sisipkan 'Pan.'
            let panitiaPart = "";
            if (data.kode_panitia && data.kode_panitia.trim() !== "") {
                panitiaPart = `/Pan.${data.kode_panitia.trim()}`;
            }

            // === LOGIKA UNIT ===
            // Jika MIJ: kosong (nanti digabung di akhir). Jika Unit lain: /KB, /MTs, dll
            let unitPart = (data.unit_kop === 'MIJ') ? '' : `/${data.unit_kop}`;
            
            // Format Akhir: No/KodeSurat[/Pan.XXX][/Unit]/MIJ/Bulan/Tahun
            // Contoh Unit: 001/SK/Pan.HGN/KB/MIJ/XI/2025
            // Contoh MIJ:  001/SK/Pan.HGN/MIJ/XI/2025
            
            const romawi = toRoman(now.getMonth()+1);
            const tahun = now.getFullYear();
            
            finalNomor = `${String(nextNo).padStart(3,'0')}/${format}${panitiaPart}${unitPart}/MIJ/${romawi}/${tahun}`;
        });
        await ref.update({ status_global: 'APPROVED', 'approver.status': 'APPROVED', 'approver.ttd_date': admin.firestore.FieldValue.serverTimestamp(), nomor_surat: finalNomor, revision_note: admin.firestore.FieldValue.delete() });
        res.json({ success: true, nomor: finalNomor });
    } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/letters/:id/download', async (req, res) => {
    try {
        const doc = await db.collection('letters').doc(req.params.id).get();
        if (!doc.exists) return res.status(404).send("Not Found");
        const data = doc.data();
        const pdfBuffer = await createPDFBuffer({ ...data, id_surat: req.params.id });
        const clean = (str) => (str || '').replace(/[^a-zA-Z0-9-_ ]/g, '').trim();
        const filename = `${clean(data.perihal).substring(0, 30)}.pdf`;
        res.setHeader('Content-Type', 'application/pdf');
        res.setHeader('Content-Disposition', `inline; filename="${filename}"`);
        res.send(pdfBuffer);
    } catch (e) { res.status(500).send(e.message); }
});

app.get('/api/public/verify/:id', async (req, res) => {
    try {
        const { id } = req.params;
        const doc = await db.collection('letters').doc(id).get();
        if (!doc.exists) return res.status(404).json({ success: false, message: "Data surat tidak ditemukan." });
        const data = doc.data();
        const publicData = {
            id_surat: data.id_surat,
            nomor_surat: data.nomor_surat,
            status_global: data.status_global,
            created_at: data.created_at,
            perihal: data.perihal,
            tujuan_jabatan: data.tujuan_jabatan || data.tujuan_surat?.jabatan,
            tujuan_nama: data.tujuan_nama || data.tujuan_surat?.nama,
            maker_unit: data.maker?.unit,
            approver_nama: data.approver?.nama,
            approver_jabatan: data.approver?.jabatan,
            approver_ttd_date: data.approver?.ttd_date,
            isi_snippet: (data.isi_ringkas || data.isi_surat || '').replace(/<[^>]*>?/gm, '').substring(0, 150) + '...'
        };
        res.json({ success: true, data: publicData });
    } catch (e) {
        console.error("Verify Error:", e);
        res.status(500).json({ success: false, message: "Server error." });
    }
});

// ... (kode API routes di atasnya biarkan saja) ...

// === DEPLOYMENT SETUP ===
// 1. Serve File Statis React (Frontend)
app.use(express.static(path.join(__dirname, 'public_html')));

// 2. Handle React Router (Agar saat di-refresh tidak 404)
app.get(/.*/, (req, res) => { 
        res.sendFile(path.resolve(__dirname, 'public_html', 'index.html'));
    });

// Jalankan Server (Gunakan process.env.PORT untuk Railway)
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`🚀 SERVER ONLINE DI PORT ${PORT}`));