const toRoman = (num) => ["", "I", "II", "III", "IV", "V", "VI", "VII", "VIII", "IX", "X", "XI", "XII"][num] || "";

const getFiscalYear = (dateObj) => {
    const month = dateObj.getMonth() + 1;
    const year = dateObj.getFullYear();
    return month >= 7 ? `${year}/${year + 1}` : `${year - 1}/${year}`;
};

// Return: "26 November 2025 M"
const getMasehiDate = (dateObj) => {
    return `${dateObj.toLocaleDateString('id-ID', { day: 'numeric', month: 'long', year: 'numeric' })} M`;
};

// Return: "6 Jumadilakhir 1447 H" (Tanpa Jakarta)
const getHijriDate = (dateObj) => {
    const hijri = new Intl.DateTimeFormat('id-ID-u-ca-islamic', {
        day: 'numeric', month: 'long', year: 'numeric'
    }).format(dateObj);
    return `${hijri.replace('Tahun', '').trim()}`;
};

module.exports = { toRoman, getFiscalYear, getMasehiDate, getHijriDate };