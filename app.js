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

// === MAIN PDF GENERATOR (REVISI FONT SIZE SERAGAM) ===
async function createPDFBuffer(data) {
    if (data.mode_buat === 'upload' && data.uploaded_file_base64) {
        const isApproved = data.status_global === 'APPROVED';
        const nomorSurat = isApproved ? data.nomor_surat : "Draft/......../........";
        const qrLink = isApproved ? `https://eoffice.mij.sch.id/verify/${data.id_surat}` : 'PREVIEW_QR';
        
        return await stampPDF(data.uploaded_file_base64, {
            nomor_surat: nomorSurat,
            qr_data: qrLink,
            locations: data.stamp_locations || [],
            lampiran: data.lampiran || [],
            render_width: data.render_width || 600
        });
    }

    try {
        const kop = imgToBase64('src/assets/Kop_Surat_Resmi.png');
        const foot = imgToBase64('src/assets/Footer_Surat.png');
        
        const isApproved = data.status_global === 'APPROVED';
        let qrBase64 = null;
        if (isApproved) {
            const info = `https://eoffice.mij.sch.id/verify/${data.id_surat}`;
            try {
                const canvasSize = 200;
                const canvas = createCanvas(canvasSize, canvasSize);
                await QRCode.toCanvas(canvas, info, { width: canvasSize, margin: 1, errorCorrectionLevel: 'H' });
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
                qrBase64 = canvas.toDataURL();
            } catch (e) { qrBase64 = await QRCode.toDataURL(info, { width: 120, margin: 1 }); }
        }

        let dateSrc = new Date();
        if (isApproved && data.approver?.ttd_date) {
            dateSrc = new Date(data.approver.ttd_date._seconds * 1000);
        }
        const tglMasehiParts = getMasehiParts(dateSrc);
        const tglHijriParts = getHijriParts(dateSrc);

        const nomorSurat = isApproved ? data.nomor_surat : "Draft/......../........";
        const lampiranText = (data.lampiran && data.lampiran.length > 0) ? "1 (satu) Berkas" : "-";

        // === REVISI 1: TEMBUSAN (Hapus font-size: 10pt agar ikut default 12pt) ===
        let tembusanHtml = '';
        if (data.tembusan && data.tembusan.length > 0) {
            tembusanHtml = `
                <div style="height: 125px;"></div> 
                <div style="text-align: left;"> <b style="text-decoration: underline;">Tembusan:</b>
                    <ol style="margin-top: 2px; padding-left: 15px; margin-bottom: 0;">
                        ${data.tembusan.map(t => `<li style="padding-left: 5px;">${t}</li>`).join('')}
                    </ol>
                </div>`;
        }

        let ttdVisual = '';
        if (isApproved && qrBase64) {
            ttdVisual = `<img src="${qrBase64}" style="width: 80px; height: 80px;">`;
        } else {
            ttdVisual = `<div style="width: 100px; height: 60px; border: 2px dashed #ccc; margin: 0 auto; display: flex; align-items: center; justify-content: center; color: #ccc; font-size: 9pt; font-weight: bold;">DRAFT TTD</div>`;
        }

        const htmlContent = `<!DOCTYPE html><html><head><style>
        /* Default Font 12pt untuk seluruh Body */
        @page { size: 215mm 330mm; margin: 0; } body { font-family: 'Trebuchet MS', sans-serif; font-size: 12pt; margin: 0; padding: 0; }
        .page-content { padding: 5px 25mm 30mm 25mm; } .header-img { width: 100%; margin-bottom: 5px; }
        
        .date-table { float: right; border-collapse: collapse; margin-bottom: 15px; } 
        .date-table td { padding: 0; vertical-align: top; }
        .hijri-row-cell { border-bottom: 1px solid #000; padding-bottom: 1px; margin-bottom: 1px; }
        .date-flex { display: flex; justify-content: space-between; gap: 20px; }

        .meta-table { width: 100%; border-collapse: collapse; margin-bottom: 15px; } .meta-table td { vertical-align: top; padding: 1px 0; }
        .content { text-align: justify; } .content p { margin: 0 0 6px 0; text-indent: 40px; } .content ol { margin: 0 0 6px 0; padding-left: 45px; }
        table { border-collapse: collapse !important; border-spacing: 0; }
        .content table { width: 100% !important; margin: 10px 0; }
        .content table td, .content table th { padding: 4px; vertical-align: top; }
        .signature-wrapper { margin-top: 20px; page-break-inside: avoid; } .signature-table { width: 100%; border: none; }
        .ttd-box { text-align: center; padding-left: 10px; } .ttd-space { height: 85px; display: flex; align-items: center; justify-content: center; margin: 2px 0; }
        .footer-img { position: fixed; bottom: 0; left: 0; width: 100%; z-index: -10; }
        </style></head><body>
        <img src="${kop}" class="header-img">
        <div class="page-content">
            <div style="overflow: hidden;">
                <table class="date-table">
                    <tr>
                        <td rowspan="2" style="padding-right:5px; padding-top: 2px;">Jakarta, </td>
                        <td class="hijri-row-cell">
                            <div class="date-flex">
                                <span>${tglHijriParts.dateStr}</span>
                                <span>${tglHijriParts.yearStr}</span>
                            </div>
                        </td>
                    </tr>
                    <tr>
                        <td>
                            <div class="date-flex">
                                <span>${tglMasehiParts.dateStr}</span>
                                <span>${tglMasehiParts.yearStr}</span>
                            </div>
                        </td>
                    </tr>
                </table>
            </div>
            <div style="clear:both;"></div>

            <table class="meta-table"><tr><td style="width:80px;">Nomor</td><td style="width:10px;">:</td><td>${nomorSurat}</td></tr><tr><td>Lampiran</td><td>:</td><td>${lampiranText}</td></tr><tr><td>Perihal</td><td>:</td><td style="font-weight:bold;">${data.perihal}</td></tr></table>
            <div style="margin-bottom:15px;">Kepada Yth.<br/><b>${data.tujuan_jabatan||''}</b><br/>${data.tujuan_nama||''}<br/>di Tempat</div>
            <div class="content">${data.isi_ringkas||''}</div>
            <div class="signature-wrapper"><table class="signature-table"><tr>
                <td style="width:50%; vertical-align:top; padding-right:10px;">${tembusanHtml}</td>
                <td style="width:50%; vertical-align:top;">
                    <div class="ttd-box">
                        <div>Hormat Kami,</div>
                        <div style="font-weight:bold; margin-bottom:5px;">${data.approver?.jabatan||'Pejabat'}</div>
                        <div class="ttd-space">${ttdVisual}</div>
                        <div style="font-weight:bold; text-decoration:underline;">${data.approver?.nama||'Nama'}</div>
                        <div>NIP. ${data.approver?.nip||'-'}</div>
                    </div>
                </td>
            </tr></table></div>
        </div>
        <img src="${foot}" class="footer-img">
        </body></html>`;

        // MENJADI INI (LEBIH AMAN BUAT SERVER):
        const browser = await puppeteer.launch({ 
            headless: 'new', 
            args: [
                '--no-sandbox', 
                '--disable-setuid-sandbox', 
                '--disable-dev-shm-usage', // Penting untuk container Railway
                '--disable-gpu'
            ] 
        });
        const page = await browser.newPage();
        await page.setContent(htmlContent, { waitUntil: 'networkidle0' });
        await page.evaluate(() => {
             const content = document.body; const SAFE_HEIGHT=1150; let fontSize=12;
             while(content.scrollHeight>SAFE_HEIGHT && fontSize>8){ fontSize-=0.5; content.style.fontSize=fontSize+'pt'; document.querySelectorAll('table').forEach(t=>t.style.fontSize=fontSize+'pt'); }
        });
        const mainPdfUint8Array = await page.pdf({ width: '215mm', height: '330mm', printBackground: true, margin: {top:0,right:0,bottom:0,left:0} });
        await browser.close();
        
        if (data.lampiran && data.lampiran.length > 0) {
            const mergedPdf = await PDFDocument.load(mainPdfUint8Array);
            for (const att of data.lampiran) {
                let rawString = (typeof att === 'object' && att.data) ? att.data : att;
                if (typeof rawString === 'string' && rawString.includes('base64,')) {
                    try {
                        const pdfData = rawString.split('base64,')[1];
                        const attPdf = await PDFDocument.load(Buffer.from(pdfData, 'base64'));
                        const copied = await mergedPdf.copyPages(attPdf, attPdf.getPageIndices());
                        copied.forEach(p => mergedPdf.addPage(p));
                    } catch(e) { console.error("Gagal merge 1 lampiran:", e.message); }
                }
            }
            return Buffer.from(await mergedPdf.save());
        }

        return Buffer.from(mainPdfUint8Array);

    } catch (error) { console.error("CreatePDF Error:", error); throw error; }
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
                qr_data: "https://eoffice.mij.sch.id/verify/PREVIEW",
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
                if(td.need_activity || td.need_activity_code) format = `Pan.${data.kode_kegiatan}`;
            } else if (data.tipe_surat === 'manual') { format = data.manual_kode; }
            const suffix = (data.unit_kop === 'MIJ') ? '' : '/MIJ';
            finalNomor = `${String(nextNo).padStart(3,'0')}/${format}/${data.unit_kop}${suffix}/${toRoman(now.getMonth()+1)}/${now.getFullYear()}`;
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
app.get('*', (req, res) => {
    res.sendFile(path.resolve(__dirname, 'public_html', 'index.html'));
});

// Jalankan Server (Gunakan process.env.PORT untuk Railway)
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`🚀 SERVER ONLINE DI PORT ${PORT}`));