const express = require('express');
const cors = require('cors');
const admin = require('firebase-admin');
const fs = require('fs');
const path = require('path');
const puppeteer = require('puppeteer');
const handlebars = require('handlebars');
const QRCode = require('qrcode');
const ExcelJS = require('exceljs');
const { PDFDocument, rgb } = require('pdf-lib'); // Tambah rgb
const { createCanvas, loadImage } = require('canvas');
const APP_URL = "https://eoffice-mij-v3-production.up.railway.app";

// === FIREBASE INIT ===
try {
    let serviceAccount;
    if (process.env.FIREBASE_CREDENTIALS) {
        serviceAccount = JSON.parse(process.env.FIREBASE_CREDENTIALS);
    } else {
        serviceAccount = require('./serviceAccountKey.json');
    }
    admin.initializeApp({ credential: admin.credential.cert(serviceAccount) });
} catch (e) { console.error("❌ Firebase Auth Error:", e.message); }
const db = admin.firestore();

const app = express();
app.use(cors());
app.use(express.json({ limit: '50mb' })); 
app.use(express.urlencoded({ limit: '50mb', extended: true }));

// === HELPER TANGGAL & UTILS ===
const toRoman = (n) => ["","I","II","III","IV","V","VI","VII","VIII","IX","X","XI","XII"][n] || "";
const getFiscalYear = (d) => d.getMonth()+1 >= 7 ? `${d.getFullYear()}/${d.getFullYear()+1}` : `${d.getFullYear()-1}/${d.getFullYear()}`;

function toHijri(date) {
    const formatter = new Intl.DateTimeFormat('en-US-u-ca-islamic-umalqura', { day: 'numeric', month: 'numeric', year: 'numeric' });
    const parts = formatter.formatToParts(date);
    const day = parts.find(p => p.type === 'day').value;
    const month = parseInt(parts.find(p => p.type === 'month').value);
    const year = parts.find(p => p.type === 'year').value;
    return { day, month, year };
}

function getMasehiParts(date) {
    const months = ["Januari", "Februari", "Maret", "April", "Mei", "Juni", "Juli", "Agustus", "September", "Oktober", "November", "Desember"];
    return { dateStr: `${date.getDate()} ${months[date.getMonth()]}`, yearStr: `${date.getFullYear()} M` };
}

function getHijriParts(date) {
    const h = toHijri(date);
    const months = ["Muharram", "Safar", "Rabi’ul Awal", "Rabi’ul Akhir", "Jumadil Awal", "Jumadil Akhir", "Rajab", "Sya’ban", "Ramadhan", "Syawal", "Dzulqa’dah", "Dzulhijjah"];
    const monthName = months[(h.month - 1)] || months[0];
    return { dateStr: `${h.day} ${monthName}`, yearStr: `${h.year} H` };
}

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

// === 1. FUNGSI STAMPING (UPLOAD MODE - SUPPORT ALAT STEMPEL) ===
async function stampPDF(originalPdfBase64, stampData) {
    const cleanBase64 = (str) => {
        if (!str || typeof str !== 'string') return null;
        return str.replace(/^data:.*,/, "").trim();
    };

    try {
        let { nomor_surat, qr_data, locations, lampiran, render_width, reviewers, is_approved } = stampData;
        
        // Pastikan locations adalah array
        if (!locations) locations = [];

        console.log(`[StampPDF] Memproses ${locations.length} titik stempel...`); // DEBUG LOG

        const mainPdfStr = cleanBase64(originalPdfBase64);
        if (!mainPdfStr) throw new Error("File PDF Utama Kosong/Corrupt");

        const pdfBuffer = Buffer.from(mainPdfStr, 'base64');
        const pdfDoc = await PDFDocument.load(pdfBuffer);
        const pages = pdfDoc.getPages();
        const firstPage = pages[0]; 
        const { width: pageWidth, height: pageHeight } = firstPage.getSize();

        // 1. GENERATE QR CODE (Hanya jika linknya valid)
        let qrImage = null;
        if (qr_data && qr_data !== 'null') {
            try {
                const canvasSize = 300; 
                const canvas = createCanvas(canvasSize, canvasSize);
                await QRCode.toCanvas(canvas, qr_data, { width: canvasSize, margin: 1, errorCorrectionLevel: 'H' });
                
                const logoPath = path.join(__dirname, 'src', 'assets', 'logo-mij.png');
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

        const fontBold = await pdfDoc.embedFont('Helvetica-Bold');
        const fontReg = await pdfDoc.embedFont('Helvetica');
        const fontOblique = await pdfDoc.embedFont('Helvetica-Oblique');

        // 2. PROSES KOORDINAT DARI ALAT STEMPEL (FRONTEND)
        for (const loc of locations) {
            try {
                // Ambil Page Index (Default halaman 1 / index 0 jika tidak ada)
                const pageIdx = parseInt(loc.pageIndex) || 0;
                if (pageIdx < 0 || pageIdx >= pages.length) continue;
                
                const targetPage = pages[pageIdx];
                const { width: pgW, height: pgH } = targetPage.getSize();
                
                // Kalkulasi Skala (PENTING AGAR POSISI TIDAK LARI)
                // Jika render_width kosong, kita asumsikan 600px (lebar standar canvas preview)
                const safeWidth = (parseFloat(render_width) > 50) ? parseFloat(render_width) : 600; 
                const scale = pgW / safeWidth;
                
                // Koordinat & Dimensi
                const finalW = (parseFloat(loc.w) || 80) * scale;
                const finalH = (parseFloat(loc.h) || 80) * scale;
                const finalX = (parseFloat(loc.x) || 0) * scale;
                
                // Konversi Y: Web (0 di Atas) -> PDF (0 di Bawah)
                const finalY = pgH - ((parseFloat(loc.y) || 0) * scale) - finalH; 

                // Normalisasi Tipe (biar huruf besar/kecil tidak masalah)
                const type = (loc.type || '').toLowerCase();
                
                console.log(` -> Stamping [${type}] di Hal:${pageIdx} (x:${finalX.toFixed(0)}, y:${finalY.toFixed(0)})`); // DEBUG LOG

                if (type.includes('qr') && qrImage) {
                    targetPage.drawImage(qrImage, { x: finalX, y: finalY, width: finalW, height: finalH });
                } 
                else if (type.includes('nomor') || type.includes('number')) {
                    // Font size menyesuaikan tinggi kotak, minimal 9pt
                    let fontSize = Math.floor(finalH * 0.60);
                    if(fontSize < 9) fontSize = 9;
                    if(fontSize > 14) fontSize = 14; 
                    
                    targetPage.drawText(String(nomor_surat || '-'), { 
                        x: finalX, 
                        y: finalY + (finalH * 0.25), // Sedikit padding biar di tengah vertikal
                        size: fontSize, 
                        font: fontBold, 
                        color: rgb(0,0,0) 
                    });
                }
            } catch (errStamp) { console.log("Loop Error:", errStamp); }
        }

        // 3. ELEMEN FIX: DISCLAIMER & PEMARAF (Otomatis di Bawah)
        if (is_approved) {
            // A. DISCLAIMER (DIGITAL SIGNATURE) - Posisi Aman
            const textDisclaimer = "Dokumen ini telah ditandatangani secara elektronik (Digital Signature) | Validitas dokumen dapat dicek melalui QR Code di atas.";
            const sizeDisc = 8;
            const textWidth = fontOblique.widthOfTextAtSize(textDisclaimer, sizeDisc);
            const xDisc = (pageWidth - textWidth) / 2; // Center
            const yDisc = 30; // Tinggi aman dari footer

            firstPage.drawText(textDisclaimer, {
                x: xDisc,
                y: yDisc,
                size: sizeDisc,
                font: fontOblique,
                color: rgb(0.4, 0.4, 0.4), 
            });

            // B. DAFTAR PEMARAF (REVIEWERS) - Di atas Disclaimer
            if (reviewers && Array.isArray(reviewers) && reviewers.length > 0) {
                const approvedReviewers = reviewers.filter(r => r.status === 'APPROVED');
                if (approvedReviewers.length > 0) {
                    const names = approvedReviewers.map(r => `[ ${r.nama} ]`).join(' / ');
                    const textParaf = `Paraf Koordinasi: ${names}`;
                    const sizeParaf = 8;
                    const textWidthParaf = fontReg.widthOfTextAtSize(textParaf, sizeParaf);
                    const xParaf = (pageWidth - textWidthParaf) / 2; // Center
                    const yParaf = yDisc + 15; 

                    firstPage.drawText(textParaf, {
                        x: xParaf,
                        y: yParaf,
                        size: sizeParaf,
                        font: fontReg,
                        color: rgb(0.2, 0.2, 0.2), 
                    });
                }
            }
        } else {
            // MODE DRAFT
            const textDraft = "DRAFT - PREVIEW MODE";
            firstPage.drawText(textDraft, {
                x: 20, y: pageHeight - 40, size: 18, font: fontBold, color: rgb(1, 0, 0), 
            });
        }

        // 4. MERGE LAMPIRAN
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
    } catch (e) { throw new Error("Gagal memproses PDF: " + e.message); }
}

// === 2. MAIN PDF GENERATOR (WEB MODE - HTML) ===
async function createPDFBuffer(data) {
    const APP_URL = "https://eoffice-mij-v3-production.up.railway.app"; 

// A. JIKA MODE UPLOAD
    if (data.mode_buat === 'upload' && data.uploaded_file_base64) {
        const isApproved = data.status_global === 'APPROVED';
        const nomorSurat = isApproved ? data.nomor_surat : "Draft/......../........";
        const qrLink = isApproved ? `${APP_URL}/verify/${data.id_surat}` : 'PREVIEW_QR';
        
        return await stampPDF(data.uploaded_file_base64, {
            nomor_surat: nomorSurat,
            qr_data: qrLink,
            locations: data.stamp_locations || [],
            lampiran: data.lampiran || [],
            render_width: data.render_width || 600,
            
            // TAMBAHAN DATA PENTING UNTUK STAMP
            reviewers: data.reviewers || [], // Kirim data pemaraf
            is_approved: isApproved          // Kirim status approve
        });
    }

    // B. JIKA MODE WEB (HTML)
    try {
        const kop = imgToBase64('src/assets/Kop_Surat_Resmi.png');
        const foot = imgToBase64('src/assets/Footer_Surat.png');
        const isApproved = data.status_global === 'APPROVED';
        let qrBase64 = null;
        
        // Generate QR
        if (isApproved) {
            const info = `${APP_URL}/verify/${data.id_surat}`;
            try {
                const canvasSize = 200;
                const canvas = createCanvas(canvasSize, canvasSize);
                await QRCode.toCanvas(canvas, info, { width: canvasSize, margin: 1, errorCorrectionLevel: 'H' });
                
                const logoPath = path.join(__dirname, 'src', 'assets', 'logo-mij.png');
                if (fs.existsSync(logoPath)) {
                      const ctx = canvas.getContext('2d');
                      const logoImg = await loadImage(logoPath);
                      const logoSize = canvasSize * 0.23;
                      const logoPos = (canvasSize - logoSize) / 2;
                      ctx.fillStyle = '#ffffff';
                      ctx.fillRect(logoPos - 3, logoPos - 3, logoSize + 6, logoSize + 6);
                      ctx.drawImage(logoImg, logoPos, logoPos, logoSize, logoSize);
                }
                qrBase64 = canvas.toDataURL();
            } catch (e) { qrBase64 = await QRCode.toDataURL(info, { width: 120, margin: 1 }); }
        }

        let dateSrc = new Date();
        if (isApproved && data.approver?.ttd_date) dateSrc = new Date(data.approver.ttd_date._seconds * 1000);
        const tglMasehiParts = getMasehiParts(dateSrc);
        const tglHijriParts = getHijriParts(dateSrc);

        const nomorSurat = isApproved ? data.nomor_surat : "Draft/......../........";
        const lampiranText = (data.lampiran && data.lampiran.length > 0) ? "1 (satu) Berkas" : "-";
        
        // --- TEMBUSAN ---
        let tembusanHtml = '';
        if (data.tembusan && data.tembusan.length > 0) {
            tembusanHtml = `
            <div style="margin-top: 5px; font-size: 10pt;">
                <b style="text-decoration: underline;">Tembusan:</b>
                <ol style="margin-top: 0.2em; padding-left: 20px; margin-bottom: 0;">
                    ${data.tembusan.map(t => `<li style="padding-left: 5px;">${t}</li>`).join('')}
                </ol>
            </div>`;
        }

        // --- DAFTAR PEMARAF (PARAF LIST) ---
        let parafHtml = '';
        if (data.reviewers && data.reviewers.length > 0) {
             const approvedReviewers = data.reviewers.filter(r => r.status === 'APPROVED');
             if(approvedReviewers.length > 0) {
                parafHtml = `
                <div style="margin-top: 15px; font-size: 9pt; color: #555; text-align: left;">
                    <b>Paraf Koordinasi:</b>
                    <span style="margin-left: 5px;">
                        ${approvedReviewers.map(r => {
                            return `[ ${r.nama} ] `;
                        }).join(' / ')}
                    </span>
                </div>
                `;
             }
        }

        // --- WATERMARK DIGITAL SIGNATURE (UPDATED) ---
        let watermarkHtml = '';
        if(isApproved) {
            watermarkHtml = `
            <div class="footer-disclaimer">
                <i>Dokumen ini telah ditandatangani secara elektronik (Digital Signature) | Validitas dokumen dapat dicek melalui QR Code di atas.</i>
            </div>
            `;
        }

        let ttdVisual = isApproved && qrBase64 
            ? `<img src="${qrBase64}" style="width: 80px; height: 80px;">` 
            : `<div style="width: 100px; height: 60px; border: 2px dashed #999; display: flex; align-items: center; justify-content: center; color: #999; font-size: 0.8em; font-weight: bold;">DRAFT TTD</div>`;
            // --- HTML CONTENT (REVISI CSS LENGKAP) ---
        const htmlContent = `<!DOCTYPE html>
        <html>
        <head>
            <style>
                * { font-family: 'Times New Roman', serif !important; box-sizing: border-box; }
                @page { size: 215mm 330mm; margin: 0; }
                body { margin: 0; padding: 0; font-size: 12pt; line-height: 1.35; color: #000; background: #fff; }
                
                /* REVISI PENTING: Padding Bottom diperbesar (40mm) agar konten berhenti JAUH sebelum footer */
                .page-content { 
                    padding: 5px 25mm 40mm 25mm; 
                    position: relative; 
                    z-index: 10; 
                    min-height: 85vh; 
                }
                
                .header-img { width: 100%; display: block; margin-bottom: 0; }
                .footer-img { position: fixed; bottom: 0; left: 0; width: 100%; z-index: -10; }
                
                .content { text-align: justify; font-size: inherit; width: 100%; }
                .content p { margin-top: 0; margin-bottom: 0.8em; text-indent: 40px; }
                .content ol, .content ul { margin: 0 0 0.8em 0; padding-left: 45px; }
                
                .content table { width: 100% !important; margin: 0.5em 0; border-collapse: collapse; }
                .content table td { padding: 2px 4px; vertical-align: top; }

                .meta-table { width: 100%; border-collapse: collapse; margin-bottom: 1.5em; }
                .meta-table td { vertical-align: top; padding: 1px 0; }
                
                .signature-wrapper { margin-top: 2em; page-break-inside: avoid; width: 100%; }
                .signature-table { width: 100%; border: none; }
                .ttd-col { text-align: center; padding-left: 10px; }
                .ttd-space { height: 6em; display: flex; align-items: center; justify-content: center; }
                
                /* REVISI PENTING: Margin & Positioning Disclaimer */
                .footer-disclaimer {
                    margin-top: 20px; 
                    font-size: 8pt; 
                    color: #888; 
                    text-align: center; 
                    border-top: 1px solid #ddd; 
                    padding-top: 5px;
                    
                    /* Angkat sedikit dan beri background putih transparan */
                    position: relative;
                    top: -10px; 
                    background-color: rgba(255,255,255,0.8);
                }

                .clearfix::after { content: ""; clear: both; display: table; }
            </style>
        </head>
        <body>
            <img src="${kop}" class="header-img">
            
            <div class="page-content">
                <div class="clearfix">
                    <div style="float: right; text-align: right;">
                        Jakarta, ${tglMasehiParts.dateStr} ${tglMasehiParts.yearStr}<br>
                        ${tglHijriParts.dateStr} ${tglHijriParts.yearStr}
                    </div>
                </div>
                <div style="clear:both; margin-bottom: 20px;"></div>

                <table class="meta-table">
                    <tr><td style="width:90px;">Nomor</td><td style="width:10px;">:</td><td>${nomorSurat}</td></tr>
                    <tr><td>Lampiran</td><td>:</td><td>${lampiranText}</td></tr>
                    <tr><td>Perihal</td><td>:</td><td style="font-weight:bold;">${data.perihal}</td></tr>
                </table>

                <div style="margin-bottom: 1.5em;">
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
                                    <div style="margin-bottom: 5px;">Hormat Kami,</div>
                                    <div style="font-weight:bold; margin-bottom:0.2em;">${data.approver?.jabatan||'Pejabat'}</div>
                                    <div class="ttd-space">${ttdVisual}</div>
                                    <div style="font-weight:bold; text-decoration:underline; margin-top:5px;">${data.approver?.nama||'Nama'}</div>
                                    ${data.approver?.nip ? `<div>NIP. ${data.approver.nip}</div>` : ''}
                                </div>
                            </td>
                        </tr>
                    </table>
                    
                    ${parafHtml}
                    ${watermarkHtml}
                </div>
                
                <div style="height: 20px;"></div>
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

        await page.evaluate(() => {
            const body = document.body;
            const MAX_HEIGHT = 1180; 
            let currentSize = 12; 
            const minSize = 9;
            while (body.scrollHeight > MAX_HEIGHT && currentSize > minSize) {
                currentSize -= 0.5;
                body.style.fontSize = currentSize + 'pt';
            }
        });

        const pdfBuffer = await page.pdf({ width: '215mm', height: '330mm', printBackground: true, margin: { top:0, right:0, bottom:0, left:0 } });
        await browser.close();

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
    } catch (e) { console.error("CreatePDF Error:", e); throw e; }
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
        
        // Cari User lain untuk list Paraf & Approver
        let allUsersRaw = [];
        try {
            const usersSnap = await db.collection('users').get();
            allUsersRaw = usersSnap.docs.map(d => ({ nip: d.id, ...d.data() }));
        } catch (uErr) {}

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

        // Map users simple untuk dropdown Frontend
        const usersSimple = allUsersRaw.map(u => ({
            nip: u.nip,
            nama: constructName(u),
            jabatan: getJobTitle(u)
        })).sort((a,b) => a.nama.localeCompare(b.nama));

        let userData = null;
        if(nip) {
            const uDoc = await db.collection('users').doc(nip).get();
            if(uDoc.exists) userData = uDoc.data();
        }
        res.json({ units: allUnits, types: types, user_raw: userData, users_list: usersSimple });
    } catch(e) { res.status(500).json({error: e.message}); }
});

app.post('/api/preview-pdf', async (req, res) => {
    try {
        const { mode_buat, upload_data, approver_nip, ...sisaData } = req.body;
        // Mode Upload
        if (mode_buat === 'upload' && upload_data) {
            const previewPdf = await stampPDF(upload_data.file_base64, {
                nomor_surat: "Draft/Preview/...",
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
        if (approver_nip) {
            try { const d = await db.collection('users').doc(approver_nip).get(); if(d.exists) approverData = d.data(); } catch(e){}
        }
        
        // Simulasikan Reviewers jika ada
        const reviewersSimulated = (sisaData.reviewers || []).map(r => ({ ...r, status: 'APPROVED', approved_at: { _seconds: Date.now()/1000 } }));

        const mockData = {
            ...sisaData, 
            status_global: 'DRAFT',
            approver: { 
                nama: constructName(approverData) || "NAMA APPROVER", 
                jabatan: getJobTitle(approverData) || "JABATAN", 
                nip: approver_nip || "NIP. -"
            },
            reviewers: reviewersSimulated, // Tampilkan simulasi paraf
            id_surat: 'PREVIEW',
            isi_ringkas: sisaData.isi_surat || ''
        };
        const pdfBuffer = await createPDFBuffer(mockData);
        res.set({'Content-Type':'application/pdf'}); res.send(pdfBuffer);
    } catch (e) { res.status(500).json({ error: "Preview Error: " + e.message }); }
});

// === CREATE / UPDATE LETTER (REVISI: SUPPORT MULTI REVIEWERS) ===
app.post('/api/letters', async (req, res) => {
    try {
        // reviewers_nips: Array of string NIP ["123", "456"] (Urutan dari UI)
        const { approver_nip, maker_nip, mode_buat, upload_data, id_surat, reviewers_nips, ...data } = req.body;
        if (!approver_nip) return res.status(400).json({ error: "NIP Penandatangan Kosong!" });
        
        const approverDoc = await db.collection('users').doc(approver_nip).get();
        const makerDoc = await db.collection('users').doc(maker_nip).get();
        const makerData = makerDoc.exists ? makerDoc.data() : {};
        const approverData = approverDoc.exists ? approverDoc.data() : {};

        // Proses Reviewers Data
        let reviewers = [];
        if (reviewers_nips && Array.isArray(reviewers_nips) && reviewers_nips.length > 0) {
            for (const rNip of reviewers_nips) {
                const rDoc = await db.collection('users').doc(rNip).get();
                if(rDoc.exists) {
                    const rData = rDoc.data();
                    reviewers.push({
                        nip: rNip,
                        nama: constructName(rData),
                        jabatan: getJobTitle(rData),
                        status: 'PENDING',
                        approved_at: null
                    });
                }
            }
        }

        let ref, isUpdate = false;
        if (id_surat && id_surat !== 'null') {
            const docCheck = await db.collection('letters').doc(id_surat).get();
            if (docCheck.exists) { ref = db.collection('letters').doc(id_surat); isUpdate = true; }
            else { ref = db.collection('letters').doc(); }
        } else { ref = db.collection('letters').doc(); }

        let letterData = {
            id_surat: ref.id,
            ...data,
            status_global: 'PROSES', 
            maker: { nip: maker_nip, unit: data.unit_kop, nama: constructName(makerData), jabatan: getJobTitle(makerData) },
            approver: { nip: approver_nip, nama: constructName(approverData), jabatan: getJobTitle(approverData), status: 'PENDING' },
            reviewers: reviewers, // Array Objek Reviewers
            current_step: 0,      // 0..N (Reviewers), N+1 (Approver)
            reviewers_count: reviewers.length,
            reviewers_search: reviewers.map(r => r.nip), // Untuk searching query
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

// === ENDPOINT ARSIP SURAT (MY LETTERS) - REVISI FINAL "OWNER + UNIT" ===
app.get('/api/my-letters', async (req, res) => {
    try {
        const nip = req.query.nip;
        let role = 'User';
        let myUnit = '';
        
        // 1. Cek Role User
        try {
            const userDoc = await db.collection('users').doc(nip).get();
            if (userDoc.exists) {
                const uData = userDoc.data();
                role = uData.system_role?.role_name || 'User';
                myUnit = uData.profile?.unit_homebase || uData.unit_homebase || '';
            }
        } catch (err) { console.error("Error fetch user:", err); }

        console.log(`[MyLetters] User: ${nip} | Role: ${role} | Unit: ${myUnit}`);

        const lettersRef = db.collection('letters');
        let combinedDocs = [];

        // --- LOGIKA QUERY UTAMA ---

        if (role === 'Super Admin Global') {
            // A. GLOBAL: Melihat SELURUH surat di sistem (Otomatis termasuk surat buatan sendiri)
            // Menggunakan .get() tanpa where
            const snap = await lettersRef.get();
            combinedDocs = snap.docs;
        } 
        else {
            // B. SELAIN GLOBAL (MIJ, Satdik, User Biasa)
            // Kita pakai teknik Promise.all untuk menggabungkan "Surat Saya" + "Surat Wewenang Unit"
            
            let promises = [];

            // 1. SELALU Ambil Surat Buatan Sendiri (Milik Pribadi)
            promises.push(lettersRef.where('maker.nip', '==', nip).get());

            // 2. Tambahan Akses Unit (Sesuai Role)
            if (role === 'Super Admin Madrasah Istiqlal Jakarta') {
                // Tambah surat dengan unit 'MIJ'
                promises.push(lettersRef.where('maker.unit', '==', 'MIJ').get());
            }
            else if (role === 'Super Admin Satdik' && myUnit) {
                // Tambah surat dengan unit Homebase User
                promises.push(lettersRef.where('maker.unit', '==', myUnit).get());
            }

            // Eksekusi Paralel
            const results = await Promise.all(promises);
            
            // Gabungkan hasil query
            results.forEach(snap => {
                combinedDocs = [...combinedDocs, ...snap.docs];
            });
        }

        // --- PENGOLAHAN DATA & DEDUPLIKASI ---
        if (combinedDocs.length === 0) return res.json({ success: true, data: [] });

        // Gunakan Map untuk menghapus duplikat ID Surat
        // (Contoh: Saya Admin MIJ, saya buat surat unit MIJ. Maka surat itu muncul di Query Pribadi DAN Query Unit. Map akan menyatukannya)
        const uniqueMap = new Map();
        combinedDocs.forEach(doc => {
            const data = doc.data();
            if (!uniqueMap.has(data.id_surat)) {
                uniqueMap.set(data.id_surat, data);
            }
        });

        // Convert ke Array
        let letters = Array.from(uniqueMap.values());
        
        // Sorting (Terbaru di atas) - Dilakukan di JS agar aman dari error Index Firestore
        letters.sort((a,b) => (b.created_at?._seconds || 0) - (a.created_at?._seconds || 0));

        res.json({ success: true, data: letters });

    } catch (e) { 
        console.error("MyLetters Error:", e);
        res.status(500).json({ error: e.message }); 
    }
});

// === REVISI: INCOMING LETTERS DENGAN FILTER STEP ===
app.get('/api/incoming-letters', async (req, res) => {
    try {
        const nip = req.query.nip;
        const type = req.query.type; 
        
        // Ambil semua surat yang relevan (Approver ATAU Reviewer)
        // Cara: Ambil status 'PROSES', lalu filter di JS karena Firestore OR terbatas
        const query = db.collection('letters').where('status_global', '==', 'PROSES');
        const snap = await query.get();
        let allProses = snap.docs.map(d => d.data());

        // Filter untuk User ini
        let myTasks = allProses.filter(l => {
            const currentStep = l.current_step || 0;
            const reviewers = l.reviewers || [];
            
            // 1. Apakah giliran Approver?
            if (currentStep >= reviewers.length) {
                // Giliran Approver
                return l.approver.nip === nip;
            } else {
                // Giliran Reviewer
                const currentReviewer = reviewers[currentStep];
                return currentReviewer && currentReviewer.nip === nip;
            }
        });

        // Untuk tab History (Sudah Approve/Reject)
        if (type === 'history') {
             // Logic history bisa diperbaiki nanti untuk ambil 'APPROVED'/'REVISION' milik user
             // Sementara return kosong atau query khusus history
             const qHist = db.collection('letters').where('status_global', 'in', ['APPROVED', 'REVISION']);
             const sHist = await qHist.get();
             let allHist = sHist.docs.map(d => d.data());
             myTasks = allHist.filter(l => l.approver.nip === nip || (l.reviewers_search && l.reviewers_search.includes(nip)));
        }

        myTasks.sort((a,b) => (b.created_at?._seconds || 0) - (a.created_at?._seconds || 0));
        res.json({ success: true, data: myTasks });
    } catch (e) { res.status(500).json({ error: e.message }); }
});

// === ENDPOINT BARU: PARAF ===
app.post('/api/paraf', async (req, res) => {
    const { id_surat, nip } = req.body;
    try {
        const ref = db.collection('letters').doc(id_surat);
        await db.runTransaction(async (t) => {
            const doc = await t.get(ref);
            if (!doc.exists) throw new Error("Surat tidak ditemukan");
            const data = doc.data();
            
            const currentStep = data.current_step || 0;
            const reviewers = data.reviewers || [];

            // Validasi Giliran
            if (currentStep < reviewers.length) {
                if (reviewers[currentStep].nip !== nip) throw new Error("Bukan giliran Anda untuk memaraf");
                
                // Update Status Reviewer
                reviewers[currentStep].status = 'APPROVED';
                reviewers[currentStep].approved_at = admin.firestore.Timestamp.now();
                
                // Naikkan Step
                t.update(ref, { 
                    reviewers: reviewers, 
                    current_step: currentStep + 1 
                });
            } else {
                throw new Error("Surat sudah melewati tahap paraf");
            }
        });
        res.json({ success: true });
    } catch(e) { res.status(500).json({ error: e.message }); }
});

// === REJECT (Revisi Logic: Reset Step?) ===
app.post('/api/reject', async (req, res) => {
    const { id_surat, note, nip } = req.body; // nip rejector
    try {
        // Jika direject, status global jadi REVISION.
        // Step tidak perlu direset ke 0 jika ingin maker perbaiki, 
        // tapi biasanya balik ke maker -> ulang dari awal.
        await db.collection('letters').doc(id_surat).update({ 
            status_global: 'REVISION', 
            revision_note: note,
            rejected_by: nip
        });
        res.json({ success: true });
    } catch (e) { res.status(500).json({ error: e.message }); }
});

// === APPROVE FINAL (Logika Penomoran Baru: Unit + Tipe + Tahun) ===
app.post('/api/approve', async (req, res) => {
    const { id_surat } = req.body;
    try {
        const ref = db.collection('letters').doc(id_surat);
        const doc = await ref.get();
        if(!doc.exists) throw new Error("Surat tidak ditemukan");
        const data = doc.data();
        
        // Validasi: Pastikan semua paraf sudah selesai
        if (data.reviewers && data.current_step < data.reviewers.length) {
             throw new Error("Surat belum selesai diparaf oleh semua reviewer.");
        }

        const now = new Date();
        const fiscal = getFiscalYear(now); // Contoh: 2025/2026
        const romawi = toRoman(now.getMonth()+1);
        const tahun = now.getFullYear();

        // 1. TENTUKAN KODE FORMAT DULU (Untuk ID Counter)
        let formatCode = "NOCODE";
        let typeDocData = null;

        if (data.tipe_surat === 'manual') {
            // Jika Manual, ambil dari input user
            formatCode = data.manual_kode || "MANUAL";
        } else {
            // Jika Database, ambil dari referensi
            const typeDoc = await db.collection('letter_types').doc(data.tipe_surat).get();
            if(typeDoc.exists) {
                typeDocData = typeDoc.data();
                // Prioritas: Format Code standar, atau logic Panitia
                if(typeDocData.need_activity || typeDocData.need_activity_code) {
                    formatCode = `Pan.${data.kode_kegiatan}`;
                } else {
                    formatCode = typeDocData.format_code || typeDocData.format;
                }
            }
        }

        // Bersihkan formatCode agar aman jadi ID Dokumen (Hapus karakter aneh)
        // Contoh: "SK" -> "SK", "B.A." -> "BA", "Pan.HGN" -> "PanHGN"
        const cleanCodeForID = formatCode.replace(/[^a-zA-Z0-9]/g, '');

        // 2. BUAT COUNTER ID SPESIFIK (Unit + Tipe + Tahun)
        // Contoh ID Lama: count_MIJ_2025-2026
        // Contoh ID Baru: count_MIJ_SK_2025-2026
        const counterId = `count_${data.unit_kop}_${cleanCodeForID}_${fiscal.replace('/','-')}`;
        const counterRef = db.collection('counters').doc(counterId);

        let finalNomor = '';
        
        await db.runTransaction(async (t) => {
            const cDoc = await t.get(counterRef);
            let nextNo = 1;
            
            // Cek apakah counter tipe ini sudah ada
            if (cDoc.exists) {
                nextNo = cDoc.data().last_number + 1;
            } else {
                // Opsional: Jika mau migrasi data lama agar tidak reset ke 1, logicnya rumit.
                // Asumsi: Mulai sistem baru, reset ke 1 per tipe surat.
                nextNo = 1;
            }
            
            t.set(counterRef, { last_number: nextNo, updated_at: admin.firestore.FieldValue.serverTimestamp() }, { merge: true });

            // 3. RAKIT NOMOR SURAT
            let panitiaPart = (data.kode_panitia && data.kode_panitia.trim() !== "") ? `/Pan.${data.kode_panitia.trim()}` : "";
            let unitPart = (data.unit_kop === 'MIJ') ? '' : `/${data.unit_kop}`;
            
            // Jika tipe surat Panitia (dari database), formatCode sudah berisi "Pan.XXX".
            // Jika tipe surat manual atau biasa, formatCode adalah "SK", "BA", dll.
            
            finalNomor = `${String(nextNo).padStart(3,'0')}/${formatCode}${panitiaPart}${unitPart}/MIJ/${romawi}/${tahun}`;
        });

        await ref.update({ 
            status_global: 'APPROVED', 
            'approver.status': 'APPROVED', 
            'approver.ttd_date': admin.firestore.FieldValue.serverTimestamp(), 
            nomor_surat: finalNomor, 
            revision_note: admin.firestore.FieldValue.delete() 
        });
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

// ... (Sisa route public/verify dan excel tetap sama) ...
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
            tujuan_jabatan: data.tujuan_jabatan,
            tujuan_nama: data.tujuan_nama,
            maker_unit: data.maker?.unit,
            approver_nama: data.approver?.nama,
            approver_jabatan: data.approver?.jabatan,
            approver_ttd_date: data.approver?.ttd_date,
            isi_snippet: (data.isi_ringkas || '').replace(/<[^>]*>?/gm, '').substring(0, 150) + '...'
        };
        res.json({ success: true, data: publicData });
    } catch (e) { res.status(500).json({ success: false, message: "Server error." }); }
});

app.use(express.static(path.join(__dirname, 'public_html')));
app.get(/.*/, (req, res) => { res.sendFile(path.resolve(__dirname, 'public_html', 'index.html')); });

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`🚀 SERVER ONLINE DI PORT ${PORT}`));