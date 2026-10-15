
const assert = require("node:assert/strict");
const test = require("node:test");
const { maskujDaneKontaktowe } = require("../privacy");

test("Ukrywa adres e-mail", () => {
  const wynik = maskujDaneKontaktowe("Email: test@example.pl");
  assert.equal(wynik, "Email: [EMAIL]");
});

test("Ukrywa numer telefonu", () => {
  const wynik = maskujDaneKontaktowe("Telefon: 500 600 700");
  assert.equal(wynik, "Telefon: [TELEFON]");
});

test("Ukrywa numer z prefiksem +48", () => {
  const wynik = maskujDaneKontaktowe("Telefon: +48 500 600 700");
  assert.equal(wynik, "Telefon: [TELEFON]");
});

test("Zachowuje budzet w PLN", () => {
  const wynik = maskujDaneKontaktowe("Budżet: 650000 PLN");
  assert.equal(wynik, "Budżet: 650000 PLN");
});

test("Zachowuje budzet ze spacjami", () => {
  const wynik = maskujDaneKontaktowe("Budżet: 650 000 zł");
  assert.equal(wynik, "Budżet: 650 000 zł");
});

test("Ukrywa kontakt bez usuwania budzetu", () => {
  const wynik = maskujDaneKontaktowe(
    "Łomża, 650000 PLN, test@example.pl, 500 600 700"
  );

  assert.match(wynik, /Łomża/);
  assert.match(wynik, /650000 PLN/);
  assert.doesNotMatch(wynik, /test@example\.pl/);
  assert.doesNotMatch(wynik, /500 600 700/);
});

test("Odrzuca dane inne niz tekst", () => {
  assert.throws(
    () => maskujDaneKontaktowe(null),
    TypeError
  );
});

// Przypadki wymagajace dalszego zabezpieczenia
test.todo("Maskowanie imienia i nazwiska");
test.todo("Maskowanie nietypowych numerow telefonow");
test.todo("Weryfikacja danych przesylanych z formularza do AI");
