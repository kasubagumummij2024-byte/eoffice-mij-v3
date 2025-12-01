const fs = require('fs');
// const fetch = require('node-fetch'); // Uncomment jika perlu

const URL = 'http://localhost:3000/api/preview-pdf';

const suratData = {
    unit_kop: "MIJ",
    tipe_surat: "UNDANGAN",
    perihal: "Undangan Rapat Evaluasi V3",
    // REVISI POIN 1: Mengirim data sebagai flat fields agar terbaca di generate PDF
    tujuan_jabatan: "Kepala Bagian TU",
    tujuan_nama: "Bpk. Budi Santoso",
    isi_surat: "Sehubungan dengan pengembangan sistem E-Office V3, kami mengundang Bapak/Ibu untuk hadir pada rapat evaluasi.\n\nAgenda pembahasan meliputi migrasi database dan penyesuaian template surat.",
    approver_nip: "20090401060" 
};

async function downloadPDF(filename) {
    console.log(`\n🖨️  Sedang mencetak PDF ke ${filename}...`);
    try {
        const res = await fetch(URL, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(suratData)
        });

        if (!res.ok) {
            const err = await res.json();
            throw new Error(err.error || 'Gagal request');
        }
        const buffer = await res.arrayBuffer();
        fs.writeFileSync(filename, Buffer.from(buffer));
        console.log(`✅ SUKSES! File: ${filename}`);
    } catch (error) {
        console.error("❌ GAGAL:", error.message);
    }
}

downloadPDF('Hasil_Test_Preview.pdf');