const admin = require('firebase-admin');
const fs = require('fs');
const path = require('path'); // Tambah modul path
const csv = require('csv-parser');

try {
    const serviceAccount = require('./serviceAccountKey.json');
    admin.initializeApp({ credential: admin.credential.cert(serviceAccount) });
} catch (e) { console.error("❌ ERROR: serviceAccountKey.json hilang!"); process.exit(1); }

const db = admin.firestore();

// KONFIGURASI FOLDER CSV
const CSV_FOLDER = './csv';

// HELPER BACA CSV (AUTO-SEARCH DI DALAM FOLDER CSV)
function readCSV(keyword) {
    return new Promise((resolve, reject) => {
        const results = [];
        
        // 1. Cek apakah folder csv ada?
        if (!fs.existsSync(CSV_FOLDER)) {
            console.log(`❌ FOLDER '${CSV_FOLDER}' TIDAK DITEMUKAN!`);
            return resolve([]);
        }

        // 2. Cari file di dalam folder csv
        const dir = fs.readdirSync(CSV_FOLDER);
        const actualFile = dir.find(f => f.includes(keyword) && f.endsWith('.csv'));
        
        if (!actualFile) {
            console.log(`❌ FILE BERISI "${keyword}" TIDAK DITEMUKAN DI FOLDER '${CSV_FOLDER}'!`);
            return resolve([]);
        }

        const fullPath = path.join(CSV_FOLDER, actualFile);
        console.log(`   -> Membaca: ${fullPath}`);
        
        // 3. Deteksi Pemisah
        const content = fs.readFileSync(fullPath, 'utf-8');
        const firstLine = content.split('\n')[0];
        const separator = (firstLine.match(/;/g) || []).length > (firstLine.match(/,/g) || []).length ? ';' : ',';
        
        // console.log(`      (Pemisah: '${separator}')`);

        fs.createReadStream(fullPath)
            .pipe(csv({ separator }))
            .on('data', (data) => results.push(data))
            .on('end', () => resolve(results))
            .on('error', reject);
    });
}

function cleanKey(obj) {
    const newObj = {};
    Object.keys(obj).forEach(key => {
        let clean = key.trim();
        if (clean.charCodeAt(0) === 0xFEFF) clean = clean.slice(1);
        clean = clean.toLowerCase()
            .replace(/\(username\)/g, '').replace(/\(id\)/g, '').replace(/\(id database\)/g, '')
            .replace(/\(pisahkan koma\)/g, '').replace(/[\(\)]/g, '')
            .replace(/\s/g, '_').replace(/__+/g, '_').replace(/_$/, '');
        newObj[clean] = obj[key] ? obj[key].trim() : null;
    });
    return newObj;
}

async function seedDatabase() {
    console.log('🚀 MULAI SEEDING (TARGET FOLDER: csv/)...');
    try {
        // 1. REFERENSI UNIT
        const units = await readCSV('REFERENSI_UNIT'); 
        const unitBatch = db.batch();
        const dictionary = {}; 

        units.forEach(row => {
            const d = cleanKey(row);
            if(d.kode_unit) {
                const code = d.kode_unit.trim();
                const name = d.nama_unit_lengkap.trim();
                
                unitBatch.set(db.collection('units').doc(code), { code, name });
                
                // Isi Kamus
                dictionary[name.toLowerCase()] = code;
                dictionary[code.toLowerCase()] = code;
            }
        });
        await unitBatch.commit();
        
        // Tambahan Kamus Manual
        dictionary['tata usaha dan umum'] = 'TU&Umum';
        dictionary['madrasah istiqlal jakarta'] = 'MIJ';
        dictionary['keuangan humas dan kepegawaian'] = 'KHK';
        dictionary['madrasah ibtidaiyah'] = 'MI';
        dictionary['madrasah tsanawiyah'] = 'MTS';
        dictionary['madrasah aliyah'] = 'MA';
        dictionary['raudhatul athfal'] = 'RA';
        dictionary['kelompok bermain'] = 'KB';
        dictionary['penjamin mutu'] = 'PM';
        
        console.log(`✅ Unit Selesai. Kamus siap.`);

        // 2. TIPE SURAT
        const types = await readCSV('REFERENSI_TIPE_SURAT');
        const typeBatch = db.batch();
        types.forEach(row => {
            const d = cleanKey(row);
            if(d.kode_tipe) {
                typeBatch.set(db.collection('letter_types').doc(d.kode_tipe), { 
                    id: d.kode_tipe, name: d.nama_tipe_surat_untuk_dropdown, format_code: d.format_kode_penomoran, 
                    need_activity_code: (d.keterangan && d.keterangan.toLowerCase().includes('kegiatan')) ? true : false 
                });
            }
        });
        await typeBatch.commit();
        console.log(`✅ Tipe Surat Selesai.`);

        // 3. USERS (INTI MASALAH)
        const users = await readCSV('MASTER_USER');
        const chunkSize = 400;
        let count = 0;

        for (let i = 0; i < users.length; i += chunkSize) {
            const chunk = users.slice(i, i + chunkSize);
            const userBatch = db.batch();
            
            chunk.forEach(row => {
                const d = cleanKey(row);
                let nip = d.nip || d.nip_username; 
                
                if(nip) {
                    nip = nip.replace(/[^0-9]/g, '');
                    const name = d.nama_lengkap || d.nama_lengkap_tanpa_gelar || 'No Name';
                    
                    // LOGIC AKSES
                    let accessKey = Object.keys(d).find(k => k.includes('akses'));
                    let rawAccess = accessKey ? d[accessKey] : '';
                    let accessCodes = [];

                    if (rawAccess && rawAccess !== '-') {
                        rawAccess = rawAccess.replace(/["']/g, '');
                        accessCodes = rawAccess.split(',').map(s => {
                            const cleanS = s.trim().toLowerCase();
                            let code = dictionary[cleanS];
                            
                            // Fuzzy Search
                            if(!code) {
                                if(cleanS.includes('tata usaha')) code = 'TU&Umum';
                                else if(cleanS.includes('madrasah istiqlal')) code = 'MIJ';
                                else if(cleanS.includes('keuangan')) code = 'KHK';
                            }
                            return code;
                        }).filter(c => c);
                    }

                    // Fallback Homebase
                    let hbRaw = (d.unit_kerja_homebase || 'MIJ').trim();
                    let hbCode = dictionary[hbRaw.toLowerCase()] || hbRaw;
                    if (accessCodes.length === 0) accessCodes.push(hbCode);

                    // Rakit Nama Gelar
                    let fullName = name;
                    if (d.gelar_depan && d.gelar_depan !== '-') fullName = `${d.gelar_depan} ${fullName}`;
                    if (d.gelar_belakang && d.gelar_belakang !== '-') fullName = `${fullName}, ${d.gelar_belakang}`;

                    userBatch.set(db.collection('users').doc(nip), {
                        uid: nip, nip: nip, email_login: `${nip}@mij.app`, password_default: 'Mij12345!',
                        profile: { full_name: fullName, jabatan_struktural: d.jabatan_struktural_asli, unit_homebase: hbCode },
                        system_role: { role_name: d.role_sistem, access_create_letter_units: accessCodes },
                        created_at: admin.firestore.FieldValue.serverTimestamp()
                    }, { merge: true });
                    count++;
                }
            });
            await userBatch.commit();
        }
        console.log(`🎉 SELESAI! Total ${count} Users berhasil diupdate.`);

    } catch (e) { console.error(e); }
}
seedDatabase();