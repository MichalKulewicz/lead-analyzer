const Database = require("better-sqlite3");

const db = new Database("leads.db");

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

console.log("✅ Baza danych działa!");
console.log("✅ Tabela leads została utworzona!");