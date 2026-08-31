require("dotenv").config();

const OpenAI = require("openai");
const Database = require("better-sqlite3");
const readline = require("readline");

const client = new OpenAI({
    apiKey: process.env.OPENAI_API_KEY
});

const db = new Database("leads.db");

const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout
});

// Upewniamy się, że tabela istnieje
db.prepare(`
    CREATE TABLE IF NOT EXISTS leads (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        wiadomosc TEXT NOT NULL,
        budzet REAL,
        waluta TEXT,
        miasto TEXT,
        termin_zakupu TEXT,
        poziom_zainteresowania TEXT,
        score INTEGER,
        klasyfikacja TEXT,
        data_dodania DATETIME DEFAULT CURRENT_TIMESTAMP
    )
`).run();

async function analizujLeada(wiadomoscKlienta) {

    console.log("\n🤖 Analizuję klienta...\n");

    const response = await client.responses.create({
        model: "gpt-5-mini",
        input: `
        Jesteś systemem Lead Analyzer.

        Przeanalizuj wiadomość potencjalnego klienta.

        Wyciągnij:
        - budzet
        - waluta
        - miasto
        - termin zakupu
        - poziom zainteresowania

        Zwróć WYŁĄCZNIE poprawny JSON.

        Używaj dokładnie tych nazw pól:
        budzet
        waluta
        miasto
        termin_zakupu
        poziom_zainteresowania

        Jeżeli informacji nie ma, wpisz null.

        Wiadomość klienta:
        ${wiadomoscKlienta}
        `
    });

    const daneKlienta = JSON.parse(response.output_text);

    let score = 0;

    // BUDŻET
    if (daneKlienta.budzet >= 500000) {
        score += 40;
    } else if (daneKlienta.budzet >= 300000) {
        score += 25;
    } else if (daneKlienta.budzet !== null) {
        score += 10;
    }

    // TERMIN
    if (
        daneKlienta.termin_zakupu &&
        (
            daneKlienta.termin_zakupu.includes("miesiąc") ||
            daneKlienta.termin_zakupu.includes("miesiac") ||
            daneKlienta.termin_zakupu.includes("tydzień") ||
            daneKlienta.termin_zakupu.includes("tydzien")
        )
    ) {
        score += 30;
    } else if (daneKlienta.termin_zakupu) {
        score += 10;
    }

    // ZAINTERESOWANIE
    if (
        daneKlienta.poziom_zainteresowania === "bardzo wysoki" ||
        daneKlienta.poziom_zainteresowania === "wysoki" ||
        daneKlienta.poziom_zainteresowania === "bardzo zainteresowany"
    ) {
        score += 30;
    } else if (
        daneKlienta.poziom_zainteresowania === "średni" ||
        daneKlienta.poziom_zainteresowania === "sredni"
    ) {
        score += 15;
    }

    // KLASYFIKACJA
    let klasyfikacja;

    if (score >= 80) {
        klasyfikacja = "HOT";
    } else if (score >= 50) {
        klasyfikacja = "WARM";
    } else {
        klasyfikacja = "COLD";
    }

    // ZAPIS DO BAZY
    const zapiszLead = db.prepare(`
        INSERT INTO leads (
            wiadomosc,
            budzet,
            waluta,
            miasto,
            termin_zakupu,
            poziom_zainteresowania,
            score,
            klasyfikacja
        )
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `);

    const wynik = zapiszLead.run(
        wiadomoscKlienta,
        daneKlienta.budzet,
        daneKlienta.waluta,
        daneKlienta.miasto,
        daneKlienta.termin_zakupu,
        daneKlienta.poziom_zainteresowania,
        score,
        klasyfikacja
    );

    console.log("================================");
    console.log("       LEAD ZAPISANY");
    console.log("================================");
    console.log("ID:", wynik.lastInsertRowid);
    console.log("Miasto:", daneKlienta.miasto ?? "brak danych");
    console.log(
        "Budżet:",
        daneKlienta.budzet ?? "brak danych",
        daneKlienta.waluta ?? ""
    );
    console.log(
        "Termin:",
        daneKlienta.termin_zakupu ?? "brak danych"
    );
    console.log(
        "Zainteresowanie:",
        daneKlienta.poziom_zainteresowania ?? "brak danych"
    );
    console.log("--------------------------------");
    console.log("SCORE:", score + "/100");
    console.log("KLASYFIKACJA:", klasyfikacja);
    console.log("================================");

    db.close();
}

rl.question("Wpisz wiadomość klienta: ", async (wiadomoscKlienta) => {

    try {

        if (!wiadomoscKlienta.trim()) {
            console.log("❌ Nie wpisano wiadomości.");
            db.close();
            rl.close();
            return;
        }

        await analizujLeada(wiadomoscKlienta);

    } catch (error) {

        console.log("\n❌ WYSTĄPIŁ BŁĄD:");
        console.log(error.message);

        db.close();

    } finally {

        rl.close();

    }
});