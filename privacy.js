function maskujDaneKontaktowe(wiadomosc) {
    if (typeof wiadomosc !== "string") {
        throw new TypeError("Wiadomość musi być tekstem");
    }

    const chronioneKwoty = [];
wiadomosc = wiadomosc.replace(
  /(\bnazywam\s+się\s+)([\p{Lu}][\p{L}'-]+)\s+([\p{Lu}][\p{L}'-]+)/giu,
  "$1[IMIE_I_NAZWISKO]"
);
wiadomosc = wiadomosc.replace(
  /(\bmam\s+na\s+imię\s+)([\p{Lu}][\p{L}'-]+)\s+([\p{Lu}][\p{L}'-]+)/giu,
  "$1[IMIE_I_NAZWISKO]"
);

wiadomosc = wiadomosc.replace(
  /(\bkontakt\s*:\s*)([\p{Lu}][\p{L}'-]+)\s+([\p{Lu}][\p{L}'-]+)/giu,
  "$1[IMIE_I_NAZWISKO]"
);
    let tekst = wiadomosc.replace(
        /(?<![\w+])\d[\d\s.,]*\s*(?:PLN|złotych|zł|EUR|USD)\b/gi,
        (kwota) => {
            const indeks = chronioneKwoty.push(kwota) - 1;
            return `__KWOTA_${indeks}__`;
        }
    );

    tekst = tekst
        .replace(
            /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi,
            "[EMAIL]"
        )
        .replace(
            /(?<!\w)(?:(?:\+48|0048)[\s./-]?)?(?:\d[\s./-]?){8}\d(?!\w)/g,
            "[TELEFON]"
        );

    return tekst.replace(
        /__KWOTA_(\d+)__/g,
        (dopasowanie, indeks) =>
            chronioneKwoty[Number(indeks)] ?? dopasowanie
    );
}

module.exports = { maskujDaneKontaktowe };
