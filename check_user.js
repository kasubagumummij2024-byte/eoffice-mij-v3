const admin = require('firebase-admin');
const serviceAccount = require('./serviceAccountKey.json');
admin.initializeApp({ credential: admin.credential.cert(serviceAccount) });
const db = admin.firestore();

async function check() {
    const nip = '20250201448'; // Ganti dengan NIP yang bermasalah
    const doc = await db.collection('users').doc(nip).get();
    if (doc.exists) {
        console.log("DATA USER:", JSON.stringify(doc.data(), null, 2));
    } else {
        console.log("User tidak ditemukan");
    }
}
check();