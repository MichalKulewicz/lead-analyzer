require("dotenv").config();

const express = require("express");
const Database = require("better-sqlite3");
const OpenAI = require("openai");
const bcrypt = require("bcrypt");
const jwt = require("jsonwebtoken");
const crypto = require("crypto");
const {
    rateLimit,
    ipKeyGenerator
} = require("express-rate-limit");

const app = express();
const PORT = 3000;


// ======================================================
// KONFIGURACJA
// ======================================================

if (
    !process.env.JWT_SECRET ||
    process.env.JWT_SECRET.length < 32
) {

    console.error(
        "❌ JWT_SECRET musi mieć minimum 32 znaki."
    );

    process.exit(1);
}

if (!process.env.OPENAI_API_KEY) {

    console.error("❌ Brak OPENAI_API_KEY w .env");

    process.exit(1);
}

if (
    process.env.NODE_ENV === "production" &&
    process.env.BILLING_TEST_MODE === "true"
) {

    console.error(
        "CRITICAL: BILLING_TEST_MODE nie może działać na produkcji."
    );

    process.exit(1);
}


// ======================================================
// OPENAI
// ======================================================

const client = new OpenAI({
    apiKey: process.env.OPENAI_API_KEY
});


// ======================================================
// MIDDLEWARE
// ======================================================

app.use(express.json());
app.use(express.static("public"));

// ======================================================
// RATE LIMITING
// ======================================================

const loginLimiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    limit: 10,
    standardHeaders: "draft-8",
    legacyHeaders: false,
    message: {
        success: false,
        message:
            "Zbyt wiele prób logowania. Spróbuj ponownie za 15 minut."
    }
});


const registerLimiter = rateLimit({
    windowMs: 60 * 60 * 1000,
    limit: 5,
    standardHeaders: "draft-8",
    legacyHeaders: false,
    message: {
        success: false,
        message:
            "Zbyt wiele prób rejestracji. Spróbuj ponownie później."
    }
});


const externalLeadsLimiter = rateLimit({
    windowMs: 60 * 1000,
    limit: 60,
    standardHeaders: "draft-8",
    legacyHeaders: false,

    keyGenerator: (req) => {

        if (
            req.company &&
            req.company.id
        ) {

            return `company:${req.company.id}`;
        }

        return ipKeyGenerator(req.ip);
    },

    message: {
        success: false,
        message:
            "Przekroczono limit żądań API. Spróbuj ponownie za chwilę."
    }
});
const internalLeadsLimiter = rateLimit({
    windowMs: 60 * 1000,
    limit: 20,
    standardHeaders: "draft-8",
    legacyHeaders: false,

    keyGenerator: (req) => {

        if (
            req.user &&
            req.user.userId
        ) {
            return `user:${req.user.userId}`;
        }

        return ipKeyGenerator(req.ip);
    },

    message: {
        success: false,
        message:
            "Zbyt wiele analiz. Spróbuj ponownie za chwilę."
    }
});

// ======================================================
// BAZA
// ======================================================

const db = new Database("leads.db");

db.pragma("foreign_keys = ON");


// ======================================================
// COMPANIES
// ======================================================

db.prepare(`
    CREATE TABLE IF NOT EXISTS companies (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        nazwa TEXT NOT NULL,
        api_key TEXT,
        data_utworzenia DATETIME DEFAULT CURRENT_TIMESTAMP
    )
`).run();


const companyColumns = db
    .prepare("PRAGMA table_info(companies)")
    .all()
    .map(column => column.name);

if (!companyColumns.includes("api_key")) {

    db.prepare(`
        ALTER TABLE companies
        ADD COLUMN api_key TEXT
    `).run();
}


db.prepare(`
    CREATE UNIQUE INDEX IF NOT EXISTS idx_companies_api_key
    ON companies(api_key)
    WHERE api_key IS NOT NULL
`).run();


// ======================================================
// API KEY
// ======================================================

function generujApiKey() {

    let apiKey;
    let istnieje;

    do {

        apiKey =
            "la_live_" +
            crypto.randomBytes(24).toString("hex");

        istnieje = db.prepare(`
            SELECT id
            FROM companies
            WHERE api_key = ?
        `).get(apiKey);

    } while (istnieje);

    return apiKey;
}


const firmyBezKlucza = db.prepare(`
    SELECT id
    FROM companies
    WHERE api_key IS NULL
       OR api_key = ''
`).all();

for (const firma of firmyBezKlucza) {

    db.prepare(`
        UPDATE companies
        SET api_key = ?
        WHERE id = ?
    `).run(
        generujApiKey(),
        firma.id
    );
}


// ======================================================
// USERS
// ======================================================

db.prepare(`
    CREATE TABLE IF NOT EXISTS users (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        company_id INTEGER NOT NULL,
        email TEXT NOT NULL UNIQUE,
        password_hash TEXT NOT NULL,
        imie TEXT,
        rola TEXT DEFAULT 'USER',
        token_version INTEGER NOT NULL DEFAULT 0,
        data_utworzenia DATETIME DEFAULT CURRENT_TIMESTAMP,

        FOREIGN KEY (company_id)
            REFERENCES companies(id)
            ON DELETE CASCADE
    )
`).run();

// ======================================================
// TOKEN VERSION
// Unieważnianie starych sesji JWT
// ======================================================

const userColumns = db
    .prepare("PRAGMA table_info(users)")
    .all()
    .map(column => column.name);


if (!userColumns.includes("token_version")) {

    db.prepare(`
        ALTER TABLE users
        ADD COLUMN token_version INTEGER NOT NULL DEFAULT 0
    `).run();
}


// ======================================================
// LEADS
// ======================================================

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
        data_dodania DATETIME DEFAULT CURRENT_TIMESTAMP,
        status_obslugi TEXT DEFAULT 'NOWY',
        company_id INTEGER,

        FOREIGN KEY (company_id)
            REFERENCES companies(id)
            ON DELETE CASCADE
    )
`).run();


const leadColumns = db
    .prepare("PRAGMA table_info(leads)")
    .all()
    .map(column => column.name);

if (!leadColumns.includes("status_obslugi")) {

    db.prepare(`
        ALTER TABLE leads
        ADD COLUMN status_obslugi TEXT DEFAULT 'NOWY'
    `).run();
}

if (!leadColumns.includes("company_id")) {

    db.prepare(`
        ALTER TABLE leads
        ADD COLUMN company_id INTEGER
    `).run();
}


// ======================================================
// HISTORIA
// ======================================================

db.prepare(`
    CREATE TABLE IF NOT EXISTS lead_history (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        lead_id INTEGER NOT NULL,
        typ TEXT NOT NULL,
        stara_wartosc TEXT,
        nowa_wartosc TEXT,
        data_zmiany DATETIME DEFAULT CURRENT_TIMESTAMP,

        FOREIGN KEY (lead_id)
            REFERENCES leads(id)
            ON DELETE CASCADE
    )
`).run();


// ======================================================
// POMOCNICZE
// ======================================================

function normalizuj(tekst) {

    if (!tekst) {
        return "";
    }

    return String(tekst)
        .toLowerCase()
        .trim();
}


function poprawnyEmail(email) {

    return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
}


// ======================================================
// JWT
// ======================================================

function utworzToken(user) {

    return jwt.sign(
        {
            userId: user.id,
            companyId: user.company_id,
            email: user.email,
            rola: user.rola,
            tokenVersion:
                user.token_version ?? 0
        },
        process.env.JWT_SECRET,
        {
            expiresIn: "7d"
        }
    );
}


// ======================================================
// AUTORYZACJA
// ======================================================

function wymagajLogowania(req, res, next) {

    const authHeader =
        req.headers.authorization;

    if (
        !authHeader ||
        !authHeader.startsWith("Bearer ")
    ) {

        return res.status(401).json({
            success: false,
            message: "Musisz się zalogować."
        });
    }

    const token =
        authHeader.substring(7);

    try {

       const dane =
    jwt.verify(
        token,
        process.env.JWT_SECRET
    );


const aktualnyUser =
    db.prepare(`
        SELECT
            id,
            company_id,
            email,
            rola,
            token_version

        FROM users

        WHERE id = ?
    `).get(
        dane.userId
    );


if (!aktualnyUser) {

    return res.status(401).json({
        success: false,
        message:
            "Użytkownik nie istnieje."
    });
}


if (!Number.isInteger(dane.tokenVersion)) {

    return res.status(401).json({
        success: false,
        code: "SESSION_INVALIDATED",
        message:
            "Sesja jest nieaktualna. Zaloguj się ponownie."
    });
}

const tokenVersion =
    dane.tokenVersion;


if (
    tokenVersion !==
    aktualnyUser.token_version
) {

    return res.status(401).json({
        success: false,
        code:
            "SESSION_INVALIDATED",
        message:
            "Sesja została unieważniona. Zaloguj się ponownie."
    });
}


req.user = {
    ...dane,

    userId:
        aktualnyUser.id,

    companyId:
        aktualnyUser.company_id,

    email:
        aktualnyUser.email,

    rola:
        aktualnyUser.rola,

    tokenVersion:
        aktualnyUser.token_version
};


next();

    } catch (error) {

        return res.status(401).json({
            success: false,
            message:
                "Sesja wygasła lub token jest nieprawidłowy."
        });
    }
}


function wymagajOwnera(req, res, next) {

    if (
        !req.user ||
        req.user.rola !== "OWNER"
    ) {

        return res.status(403).json({
            success: false,
            message:
                "Tylko właściciel firmy może wykonać tę operację."
        });
    }

    next();
}


function wymagajApiKey(req, res, next) {

    const apiKey =
        req.headers["x-api-key"];

    if (!apiKey) {

        return res.status(401).json({
            success: false,
            message:
                "Brak X-API-Key."
        });
    }

    const firma = db.prepare(`
        SELECT *
        FROM companies
        WHERE api_key = ?
    `).get(apiKey);

    if (!firma) {

        return res.status(401).json({
            success: false,
            message:
                "Nieprawidłowy API key."
        });
    }

    req.company = firma;

    next();
}


// ======================================================
// SCORE
// ======================================================


function pobierzScoringFirmy(companyId) {

    let scoring = db.prepare(`
        SELECT *
        FROM company_scoring
        WHERE company_id = ?
    `).get(companyId);


    if (!scoring) {

        db.prepare(`
            INSERT INTO company_scoring (
                company_id
            )
            VALUES (?)
        `).run(companyId);


        scoring = db.prepare(`
            SELECT *
            FROM company_scoring
            WHERE company_id = ?
        `).get(companyId);
    }


    return scoring;
}


function policzScore(dane, scoring) {

    let score = 0;


    const budzet =
        Number(dane.budzet);


    if (
        dane.budzet !== null &&
        dane.budzet !== undefined &&
        !Number.isNaN(budzet)
    ) {

        if (
            budzet >= scoring.budzet_wysoki
        ) {

            score +=
                scoring.punkty_budzet_wysoki;

        } else if (
            budzet >= scoring.budzet_sredni
        ) {

            score +=
                scoring.punkty_budzet_sredni;

        } else {

            score +=
                scoring.punkty_budzet_niski;
        }
    }


    const termin =
        normalizuj(
            dane.termin_zakupu
        );


    if (
        termin.includes("miesiąc") ||
        termin.includes("miesiac") ||
        termin.includes("miesiącu") ||
        termin.includes("miesiacu") ||
        termin.includes("tydzień") ||
        termin.includes("tydzien") ||
        termin.includes("tygodniu")
    ) {

        score +=
            scoring.punkty_termin_szybki;

    } else if (termin) {

        score +=
            scoring.punkty_termin_inny;
    }


    const zainteresowanie =
        normalizuj(
            dane.poziom_zainteresowania
        );


    if (
        zainteresowanie.includes("bardzo wysoki") ||
        zainteresowanie.includes("bardzo zainteresowany") ||
        zainteresowanie.includes("bardzo zainteresowana") ||
        zainteresowanie === "wysoki"
    ) {

        score +=
            scoring.punkty_zainteresowanie_wysokie;

    } else if (
        zainteresowanie.includes("średni") ||
        zainteresowanie.includes("sredni")
    ) {

        score +=
            scoring.punkty_zainteresowanie_srednie;
    }


    return Math.min(
        Math.max(score, 0),
        100
    );
}


function klasyfikujLeada(
    score,
    scoring
) {

    if (score >= scoring.prog_hot) {
        return "HOT";
    }

    if (score >= scoring.prog_warm) {
        return "WARM";
    }

    return "COLD";
}


async function analizujWiadomosc(wiadomosc) {

    const response =
        await client.responses.create({

            model: "gpt-5-mini",

            input: `
Jesteś systemem Lead Analyzer.

Przeanalizuj wiadomość potencjalnego klienta.

Wyciągnij:
- budzet
- waluta
- miasto
- termin_zakupu
- poziom_zainteresowania

Zwróć WYŁĄCZNIE poprawny JSON:

{
    "budzet": null,
    "waluta": null,
    "miasto": null,
    "termin_zakupu": null,
    "poziom_zainteresowania": null
}

Zasady:
- budzet musi być liczbą
- polskie złote zapisuj jako PLN
- brak informacji = null
- zainteresowanie:
  bardzo wysoki / wysoki / średni / niski
- nie wymyślaj informacji
- żadnego tekstu poza JSON

Wiadomość:

${wiadomosc}
`
        });


    let tekst =
        response.output_text.trim();


    tekst = tekst
        .replace(/^```json/i, "")
        .replace(/^```/i, "")
        .replace(/```$/i, "")
        .trim();


    const dane =
        JSON.parse(tekst);


    if (dane.waluta) {

        const waluta =
            normalizuj(
                dane.waluta
            );

        if (
            waluta === "zł" ||
            waluta === "zl" ||
            waluta === "pln"
        ) {

            dane.waluta = "PLN";
        }
    }


    if (
        dane.budzet !== null &&
        dane.budzet !== undefined
    ) {

        const liczba =
            Number(
                dane.budzet
            );

        dane.budzet =
            Number.isNaN(liczba)
                ? null
                : liczba;
    }


    return dane;
}

// ======================================================
// LIMIT LEADÓW / OKRES ROZLICZENIOWY
// ======================================================

function sprawdzLimitLeadowFirmy(
    companyId
) {

    const firma =
        db.prepare(`
            SELECT
                c.id,
                c.billing_period_start,
                c.billing_period_end,

                p.kod AS plan,
                p.limit_leadow

            FROM companies c

            JOIN plans p
                ON p.id = c.plan_id

            WHERE c.id = ?
        `).get(
            companyId
        );


    if (!firma) {

        throw new Error(
            "Nie znaleziono firmy lub planu."
        );
    }


    // ==============================================
    // BRAK DAT OKRESU - TWORZYMY NOWY
    // ==============================================

    if (
        !firma.billing_period_start ||
        !firma.billing_period_end
    ) {

        db.prepare(`
            UPDATE companies

            SET
                billing_period_start =
                    CURRENT_TIMESTAMP,

                billing_period_end =
                    datetime(
                        CURRENT_TIMESTAMP,
                        '+1 month'
                    )

            WHERE id = ?
        `).run(
            companyId
        );
    }


    // ==============================================
    // PRZESUNIĘCIE ZAKOŃCZONEGO OKRESU
    // ==============================================

    let okres =
        db.prepare(`
            SELECT
                billing_period_start,
                billing_period_end

            FROM companies

            WHERE id = ?
        `).get(
            companyId
        );


    let zabezpieczenie = 0;


    while (
        okres.billing_period_end &&
        new Date(
            okres.billing_period_end
                .replace(" ", "T") + "Z"
        ) <= new Date()
    ) {

        db.prepare(`
            UPDATE companies

            SET
                billing_period_start =
                    billing_period_end,

                billing_period_end =
                    datetime(
                        billing_period_end,
                        '+1 month'
                    )

            WHERE id = ?
        `).run(
            companyId
        );


        okres =
            db.prepare(`
                SELECT
                    billing_period_start,
                    billing_period_end

                FROM companies

                WHERE id = ?
            `).get(
                companyId
            );


        zabezpieczenie++;


        if (zabezpieczenie > 120) {

            throw new Error(
                "Nie udało się ustalić okresu rozliczeniowego."
            );
        }
    }


    // ==============================================
    // LICZYMY LEADY TYLKO Z AKTUALNEGO OKRESU
    // ==============================================

    const wykorzystane =
        db.prepare(`
            SELECT
                COUNT(*) AS count

            FROM leads

            WHERE
                company_id = ?

                AND data_dodania >= ?

                AND data_dodania < ?
        `).get(
            companyId,
            okres.billing_period_start,
            okres.billing_period_end
        ).count;


    const limit =
        firma.limit_leadow;


    // NULL = brak sztywnego limitu
    const dozwolony =
        limit === null ||
        wykorzystane < limit;


    return {

        plan:
            firma.plan,

        used:
            Number(wykorzystane) || 0,

        limit:
            limit,

        remaining:
            limit === null
                ? null
                : Math.max(
                    Number(limit) -
                    Number(wykorzystane),
                    0
                ),

        allowed:
            dozwolony,

        billing_period_start:
            okres.billing_period_start,

        billing_period_end:
            okres.billing_period_end
    };
}
// ======================================================
// ZAPIS LEADA
// ======================================================

function zapiszLeadaDoFirmy(
    wiadomosc,
    dane,
    companyId
) {

    
const scoring =
        pobierzScoringFirmy(
            companyId
        );

    const score =
        policzScore(
            dane,
            scoring
        );

    const klasyfikacja =
        klasyfikujLeada(
            score,
            scoring
        );



    const wynik =
        db.prepare(`
            INSERT INTO leads (
                wiadomosc,
                budzet,
                waluta,
                miasto,
                termin_zakupu,
                poziom_zainteresowania,
                score,
                klasyfikacja,
                status_obslugi,
                company_id
            )
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `).run(

            wiadomosc,
            dane.budzet ?? null,
            dane.waluta ?? null,
            dane.miasto ?? null,
            dane.termin_zakupu ?? null,
            dane.poziom_zainteresowania ?? null,
            score,
            klasyfikacja,
            "NOWY",
            companyId
        );


    const id =
        Number(
            wynik.lastInsertRowid
        );


    db.prepare(`
        INSERT INTO lead_history (
            lead_id,
            typ,
            stara_wartosc,
            nowa_wartosc
        )
        VALUES (?, ?, ?, ?)
    `).run(
        id,
        "UTWORZENIE",
        null,
        "NOWY"
    );


    return db.prepare(`
        SELECT *
        FROM leads
        WHERE id = ?
    `).get(id);
}


// ======================================================
// STRONA
// ======================================================

app.get("/", (req, res) => {

    res.sendFile(
        __dirname + "/public/index.html"
    );
});


// ======================================================
// REJESTRACJA
// ======================================================

app.post(
    "/api/register",
    registerLimiter,
    async (req, res) => {

        try {

if (
    typeof req.body.nazwaFirmy !== "string" ||
    typeof req.body.imie !== "string" ||
    typeof req.body.email !== "string" ||
    typeof req.body.haslo !== "string"
) {

    return res
        .status(400)
        .json({
            success: false,
            message:
                "Nieprawidłowy format danych."
        });
}


const nazwaFirmy =
    req.body.nazwaFirmy.trim();

const imie =
    req.body.imie.trim();

const email =
    req.body.email
        .trim()
        .toLowerCase();

const haslo =
    req.body.haslo;
            


            if (!poprawnyEmail(email)) {

                return res
                    .status(400)
                    .json({
                        success: false,
                        message:
                            "Nieprawidłowy email."
                    });
            }


            if (haslo.length < 8) {

                return res
                    .status(400)
                    .json({
                        success: false,
                        message:
                            "Hasło musi mieć minimum 8 znaków."
                    });
            }


            const istnieje =
                db.prepare(`
                    SELECT id
                    FROM users
                    WHERE email = ?
                `).get(email);


            if (istnieje) {

                return res
                    .status(409)
                    .json({
                        success: false,
                        message:
                            "Konto z tym emailem już istnieje."
                    });
            }


            const passwordHash =
                await bcrypt.hash(
                    haslo,
                    12
                );


            const utworzKonto =
                db.transaction(() => {

                    const apiKey =
                        generujApiKey();


                    

                    // ==================================
                    // REGISTER_DEFAULT_PLAN_V2
                    // DOMYŚLNY PLAN STARTER
                    // ==================================

                    const starterPlan =
                        db.prepare(`
                            SELECT id
                            FROM plans
                            WHERE kod = 'STARTER'
                        `).get();


                    if (!starterPlan) {

                        throw new Error(
                            "Brak planu STARTER w bazie."
                        );
                    }


const firmaResult =
                        db.prepare(`
                            INSERT INTO companies (
                                nazwa,
                                api_key,
                                plan_id
                            )
                            VALUES (?, ?, ?)
                        `).run(
                            nazwaFirmy,
                            apiKey,
                            starterPlan.id
                        );


                    const companyId =
                        Number(
                            firmaResult.lastInsertRowid
                        );


                    const userResult =
                        db.prepare(`
                            INSERT INTO users (
                                company_id,
                                email,
                                password_hash,
                                imie,
                                rola
                            )
                            VALUES (?, ?, ?, ?, ?)
                        `).run(
                            companyId,
                            email,
                            passwordHash,
                            imie,
                            "OWNER"
                        );


                    

                    // ==================================
                    // REGISTER_DEFAULT_SCORING_V2
                    // DOMYŚLNY SCORING NOWEJ FIRMY
                    // ==================================

                    const scoringIstnieje =
                        db.prepare(`
                            SELECT id
                            FROM company_scoring
                            WHERE company_id = ?
                        `).get(
                            companyId
                        );


                    if (!scoringIstnieje) {

                        db.prepare(`
                            INSERT INTO company_scoring (
                                company_id
                            )
                            VALUES (?)
                        `).run(
                            companyId
                        );
                    }


return {
                        userId:
                            Number(
                                userResult.lastInsertRowid
                            )
                    };
                });


            const wynik =
                utworzKonto();


            const user =
                db.prepare(`
                    SELECT *
                    FROM users
                    WHERE id = ?
                `).get(
                    wynik.userId
                );


            const token =
                utworzToken(user);


            res.status(201).json({

                success: true,
                token,

                user: {
                    id: user.id,
                    email: user.email,
                    imie: user.imie,
                    rola: user.rola,
                    companyId:
                        user.company_id
                }
            });


        } catch (error) {

            console.error(error);

            res.status(500).json({
                success: false,
                message:
                    "Nie udało się utworzyć konta."
            });
        }
    }
);


// ======================================================
// LOGOWANIE
// ======================================================

app.post(
    "/api/login",
    loginLimiter,
    async (req, res) => {

        try {

            const email =
                String(
                    req.body.email || ""
                )
                .trim()
                .toLowerCase();

            const haslo =
                String(
                    req.body.haslo || ""
                );


            const user =
                db.prepare(`
                    SELECT *
                    FROM users
                    WHERE email = ?
                `).get(email);


            if (!user) {

                return res
                    .status(401)
                    .json({
                        success: false,
                        message:
                            "Nieprawidłowy email lub hasło."
                    });
            }


            const poprawne =
                await bcrypt.compare(
                    haslo,
                    user.password_hash
                );


            if (!poprawne) {

                return res
                    .status(401)
                    .json({
                        success: false,
                        message:
                            "Nieprawidłowy email lub hasło."
                    });
            }


            const token =
                utworzToken(user);


            res.json({

                success: true,
                token,

                user: {
                    id: user.id,
                    email: user.email,
                    imie: user.imie,
                    rola: user.rola,
                    companyId:
                        user.company_id
                }
            });


        } catch (error) {

            console.error(error);

            res.status(500).json({
                success: false,
                message:
                    "Błąd logowania."
            });
        }
    }
);


// ======================================================
// MOJE KONTO
// ======================================================

app.get(
    "/api/me",
    wymagajLogowania,
    (req, res) => {

        const user =
            db.prepare(`
                SELECT
                    users.id,
                    users.email,
                    users.imie,
                    users.rola,
                    users.company_id,
                    companies.nazwa AS firma

                FROM users

                JOIN companies
                    ON companies.id =
                       users.company_id

                WHERE users.id = ?
            `).get(
                req.user.userId
            );


        if (!user) {

            return res
                .status(404)
                .json({
                    success: false,
                    message:
                        "Nie znaleziono użytkownika."
                });
        }


        res.json({
            success: true,
            user
        });
    }
);


// ======================================================
// LISTA UŻYTKOWNIKÓW FIRMY
// ======================================================

app.get(
    "/api/company/users",
    wymagajLogowania,
    wymagajOwnera,
    (req, res) => {

        try {

            const users =
                db.prepare(`
                    SELECT
                        id,
                        email,
                        imie,
                        rola,
                        data_utworzenia

                    FROM users

                    WHERE company_id = ?

                    ORDER BY
                        CASE rola
                            WHEN 'OWNER' THEN 1
                            WHEN 'ADMIN' THEN 2
                            ELSE 3
                        END,
                        id ASC
                `).all(
                    req.user.companyId
                );


            res.json({
                                success: true,
                count:
                    users.length,
                users
            });


        } catch (error) {

            console.error(error);

            res.status(500).json({
                success: false,
                message:
                    "Nie udało się pobrać użytkowników."
            });
        }
    }
);


// ======================================================
// DODAWANIE PRACOWNIKA
// ======================================================

app.post(
    "/api/company/users",
    wymagajLogowania,
    wymagajOwnera,
    async (req, res) => {

        try {

            // ==========================================
            // USER_LIMIT_BY_PLAN_V1
            // LIMIT UŻYTKOWNIKÓW WG PLANU
            // ==========================================

            const planFirmy =
                db.prepare(`
                    SELECT
                        p.kod,
                        p.limit_userow

                    FROM companies c

                    JOIN plans p
                        ON p.id = c.plan_id

                    WHERE c.id = ?
                `).get(
                    req.user.companyId
                );


            if (!planFirmy) {

                return res
                    .status(500)
                    .json({

                        success: false,

                        message:
                            "Firma nie ma przypisanego planu."
                    });
            }


            const liczbaUserow =
                db.prepare(`
                    SELECT COUNT(*) AS count

                    FROM users

                    WHERE company_id = ?
                `).get(
                    req.user.companyId
                ).count;


            if (
                planFirmy.limit_userow !== null &&
                liczbaUserow >= planFirmy.limit_userow
            ) {

                return res
                    .status(403)
                    .json({

                        success: false,

                        message:
                            `Limit użytkowników dla planu ${planFirmy.kod} został osiągnięty (${liczbaUserow}/${planFirmy.limit_userow}). Zmień plan, aby dodać kolejną osobę.`
                    });
            }




           if (
    typeof req.body.imie !== "string" ||
    typeof req.body.email !== "string" ||
    typeof req.body.haslo !== "string" ||
    (
        req.body.rola !== undefined &&
        typeof req.body.rola !== "string"
    )
) {

    return res
        .status(400)
        .json({
            success: false,
            message:
                "Nieprawidłowy format danych."
        });
}


const imie =
    req.body.imie.trim();

const email =
    req.body.email
        .trim()
        .toLowerCase();

const haslo =
    req.body.haslo;

const rola =
    (req.body.rola || "USER")
        .trim()
        .toUpperCase();

            if (
                !imie ||
                !email ||
                !haslo
            ) {

                return res
                    .status(400)
                    .json({
                        success: false,
                        message:
                            "Wypełnij imię, email i hasło."
                    });
            }


            if (!poprawnyEmail(email)) {

                return res
                    .status(400)
                    .json({
                        success: false,
                        message:
                            "Nieprawidłowy email."
                    });
            }


            if (haslo.length < 8) {

                return res
                    .status(400)
                    .json({
                        success: false,
                        message:
                            "Hasło musi mieć minimum 8 znaków."
                    });
            }


            if (
                !["ADMIN", "USER"].includes(
                    rola
                )
            ) {

                return res
                    .status(400)
                    .json({
                        success: false,
                        message:
                            "Rola musi być ADMIN lub USER."
                    });
            }


            const istnieje =
                db.prepare(`
                    SELECT id
                    FROM users
                    WHERE email = ?
                `).get(email);


            if (istnieje) {

                return res
                    .status(409)
                    .json({
                        success: false,
                        message:
                            "Użytkownik z tym emailem już istnieje."
                    });
            }


            const passwordHash =
                await bcrypt.hash(
                    haslo,
                    12
                );


            const wynik =
                db.prepare(`
                    INSERT INTO users (
                        company_id,
                        email,
                        password_hash,
                        imie,
                        rola
                    )
                    VALUES (?, ?, ?, ?, ?)
                `).run(
                    req.user.companyId,
                    email,
                    passwordHash,
                    imie,
                    rola
                );


            const user =
                db.prepare(`
                    SELECT
                        id,
                        email,
                        imie,
                        rola,
                        data_utworzenia

                    FROM users

                    WHERE id = ?
                `).get(
                    wynik.lastInsertRowid
                );


            res.status(201).json({

                success: true,

                message:
                    "Pracownik został dodany.",

                user
            });


        } catch (error) {

            console.error(error);

            res.status(500).json({
                success: false,
                message:
                    "Nie udało się dodać pracownika."
            });
        }
    }
);


// ======================================================
// ZMIANA ROLI PRACOWNIKA
// ======================================================

app.patch(
    "/api/company/users/:id/role",
    wymagajLogowania,
    wymagajOwnera,
    (req, res) => {

        try {

            const id =
                Number(req.params.id);

            const nowaRola =
                String(
                    req.body.rola || ""
                )
                .trim()
                .toUpperCase();


            if (
                !["ADMIN", "USER"].includes(
                    nowaRola
                )
            ) {

                return res
                    .status(400)
                    .json({
                        success: false,
                        message:
                            "Rola musi być ADMIN lub USER."
                    });
            }


            const user =
                db.prepare(`
                    SELECT *
                    FROM users

                    WHERE
                        id = ?
                        AND company_id = ?
                `).get(
                    id,
                    req.user.companyId
                );


            if (!user) {

                return res
                    .status(404)
                    .json({
                        success: false,
                        message:
                            "Nie znaleziono użytkownika."
                    });
            }


            if (
                user.rola === "OWNER"
            ) {

                return res
                    .status(400)
                    .json({
                        success: false,
                        message:
                            "Nie można zmienić roli OWNERA."
                    });
            }


          db.prepare(`
    UPDATE users
    SET rola = ?
    WHERE
        id = ?
        AND company_id = ?
`).run(
    nowaRola,
    id,
    req.user.companyId
);


            const aktualny =
                db.prepare(`
                    SELECT
                        id,
                        email,
                        imie,
                        rola,
                        data_utworzenia

                    FROM users

                    WHERE id = ?
                `).get(id);


            res.json({

                success: true,

                message:
                    "Rola została zmieniona.",

                user:
                    aktualny
            });


        } catch (error) {

            console.error(error);

            res.status(500).json({
                success: false,
                message:
                    "Nie udało się zmienić roli."
            });
        }
    }
);


// ======================================================
// USUWANIE PRACOWNIKA
// ======================================================

app.delete(
    "/api/company/users/:id",
    wymagajLogowania,
    wymagajOwnera,
    (req, res) => {

        try {

            const id =
                Number(req.params.id);


            const user =
                db.prepare(`
                    SELECT *
                    FROM users

                    WHERE
                        id = ?
                        AND company_id = ?
                `).get(
                    id,
                    req.user.companyId
                );


            if (!user) {

                return res
                    .status(404)
                    .json({
                        success: false,
                        message:
                            "Nie znaleziono użytkownika."
                    });
            }


            if (
                user.rola === "OWNER"
            ) {

                return res
                    .status(400)
                    .json({
                        success: false,
                        message:
                            "Nie można usunąć OWNERA."
                    });
            }


           db.prepare(`
    DELETE FROM users
    WHERE
        id = ?
        AND company_id = ?
`).run(
    id,
    req.user.companyId
);


            res.json({

                success: true,

                message:
                    "Pracownik został usunięty."
            });


        } catch (error) {

            console.error(error);

            res.status(500).json({
                success: false,
                message:
                    "Nie udało się usunąć pracownika."
            });
        }
    }
);


// ======================================================
// API KEY
// ======================================================



// ======================================================
// USER_API_KEY_SECURITY_FIX_V2
// USER NIE MOŻE POBIERAĆ API KEY
// ======================================================

app.get(
    "/api/company/api-key",
    wymagajLogowania,
    (req, res, next) => {

        try {

            const user =
                db.prepare(`
                    SELECT
                        id,
                        rola,
                        company_id

                    FROM users

                    WHERE id = ?
                `).get(
                    req.user.userId
                );


            if (!user) {

                return res
                    .status(401)
                    .json({
                        success: false,
                        message:
                            "Użytkownik nie istnieje."
                    });
            }


            if (
                user.rola === "USER"
            ) {

                return res
                    .status(403)
                    .json({

                        success: false,

                        message:
                            "USER nie ma dostępu do API key."
                    });
            }


            return next();


        } catch (error) {

            console.error(
                "API key security:",
                error
            );


            return res
                .status(500)
                .json({

                    success: false,

                    message:
                        "Błąd sprawdzania uprawnień."
                });
        }
    }
);


app.get(
    "/api/company/api-key",
    wymagajLogowania,
    (req, res) => {

        const firma =
            db.prepare(`
                SELECT api_key
                FROM companies
                WHERE id = ?
                            `).get(
                req.user.companyId
            );


        if (!firma) {

            return res
                .status(404)
                .json({
                    success: false,
                    message:
                        "Nie znaleziono firmy."
                });
        }


        res.json({
            success: true,
            apiKey:
                firma.api_key
        });
    }
);


app.post(
    "/api/company/api-key/regenerate",
    wymagajLogowania,
    wymagajOwnera,
    (req, res) => {

        const apiKey =
            generujApiKey();


        db.prepare(`
            UPDATE companies
            SET api_key = ?
            WHERE id = ?
        `).run(
            apiKey,
            req.user.companyId
        );


        res.json({
            success: true,
            message:
                "Wygenerowano nowy API key.",
            apiKey
        });
    }
);


// ======================================================
// LEADY
// ======================================================



// ======================================================
// LEAD_ANALYZER_USER_PERMISSIONS
// UPRAWNIENIA OWNER / ADMIN / USER
// ======================================================

function pobierzAktualnegoUzytkownika(req) {

    return db.prepare(`
        SELECT
            id,
            company_id,
            email,
            imie,
            rola

        FROM users

        WHERE id = ?
    `).get(
        req.user.userId
    );
}


function czyUser(user) {

    return (
        user &&
        user.rola === "USER"
    );
}


// ======================================================
// USER - WYMAGAJĄ UWAGI
// ======================================================

app.get(
    "/api/leads/attention",
    wymagajLogowania,
    (req, res, next) => {

        try {

            const user =
                pobierzAktualnegoUzytkownika(
                    req
                );


            if (!czyUser(user)) {

                return next();
            }


            const leady =
                db.prepare(`
                    SELECT *
                    FROM leads

                    WHERE
                        company_id = ?
                        AND assigned_user_id = ?
                        AND status_obslugi = 'NOWY'
                        AND (
                            klasyfikacja = 'HOT'
                            OR score >= 80
                        )

                    ORDER BY
                        score DESC,
                        data_dodania ASC
                `).all(
                    user.company_id,
                    user.id
                );


            return res.json({

                success: true,

                count:
                    leady.length,

                leads:
                    leady
            });


        } catch (error) {

            console.error(
                "USER attention:",
                error
            );


            return res
                .status(500)
                .json({
                    success: false,
                    message:
                        "Nie udało się pobrać leadów."
                });
        }
    }
);


// ======================================================
// USER - LISTA LEADÓW
// ======================================================

app.get(
    "/api/leads",
    wymagajLogowania,
    async (req, res, next) => {

        try {

            const user =
                pobierzAktualnegoUzytkownika(
                    req
                );


            if (!czyUser(user)) {

                return next();
            }


            const leady =
                db.prepare(`
                    SELECT *
                    FROM leads

                    WHERE
                        company_id = ?
                        AND assigned_user_id = ?

                    ORDER BY
                        score DESC,
                        id DESC
                `).all(
                    user.company_id,
                    user.id
                );


            return res.json({

                success: true,

                count:
                    leady.length,

                leads:
                    leady
            });


        } catch (error) {

            console.error(error);


            return res
                .status(500)
                .json({
                    success: false,
                    message:
                        "Nie udało się pobrać leadów."
                });
        }
    }
);


// ======================================================
// USER - JEDEN LEAD
// ======================================================



// ======================================================
// LEAD_USER_SECURITY_FIX_V2
// USER MOŻE OTWIERAĆ TYLKO SWOJE LEADY
// ======================================================

app.get(
    "/api/leads/:id",
    wymagajLogowania,
    (req, res, next) => {

        try {

            const id =
                Number(
                    req.params.id
                );


            if (
                !Number.isInteger(id) ||
                id <= 0
            ) {

                return next();
            }


            const aktualnyUser =
                db.prepare(`
                    SELECT
                        id,
                        company_id,
                        rola

                    FROM users

                    WHERE id = ?
                `).get(
                    req.user.userId
                );


            if (!aktualnyUser) {

                return res
                    .status(401)
                    .json({
                        success: false,
                        message:
                            "Użytkownik nie istnieje."
                    });
            }


            if (
                aktualnyUser.rola === "OWNER" ||
                aktualnyUser.rola === "ADMIN"
            ) {

                return next();
            }


            const lead =
                db.prepare(`
                    SELECT *
                    FROM leads

                    WHERE
                        id = ?
                        AND company_id = ?
                        AND assigned_user_id = ?
                `).get(
                    id,
                    aktualnyUser.company_id,
                    aktualnyUser.id
                );


            if (!lead) {

                return res
                    .status(403)
                    .json({

                        success: false,

                        message:
                            "Nie masz dostępu do tego leada."
                    });
            }


            return res.json({

                success: true,

                lead
            });


        } catch (error) {

            console.error(
                "USER lead security:",
                error
            );


            return res
                .status(500)
                .json({

                    success: false,

                    message:
                        "Błąd sprawdzania uprawnień."
                });
        }
    }
);

// ======================================================
// USER - ZMIANA STATUSU TYLKO SWOJEGO LEADA
// ======================================================

app.patch(
    "/api/leads/:id/status",
    wymagajLogowania,
    (req, res, next) => {

        try {

            const user =
                pobierzAktualnegoUzytkownika(
                    req
                );


            if (!czyUser(user)) {

                return next();
            }


            const id =
                Number(
                    req.params.id
                );


            const lead =
                db.prepare(`
                    SELECT *
                    FROM leads

                    WHERE
                        id = ?
                        AND company_id = ?
                        AND assigned_user_id = ?
                `).get(
                    id,
                    user.company_id,
                    user.id
                );


            if (!lead) {

                return res
                    .status(403)
                    .json({
                        success: false,
                        message:
                            "Nie możesz zmieniać statusu tego leada."
                    });
            }


            return next();


        } catch (error) {

            console.error(error);


            return res
                .status(500)
                .json({
                    success: false,
                    message:
                        "Błąd sprawdzania uprawnień."
                });
        }
    }
);


// ======================================================
// USER - EDYCJA TYLKO SWOJEGO LEADA
// ======================================================

app.patch(
    "/api/leads/:id",
    wymagajLogowania,
    (req, res, next) => {

        try {

            const user =
                pobierzAktualnegoUzytkownika(
                    req
                );


            if (!czyUser(user)) {

                return next();
            }


            const id =
                Number(
                    req.params.id
                );


            const lead =
                db.prepare(`
                    SELECT id
                    FROM leads

                    WHERE
                        id = ?
                        AND company_id = ?
                        AND assigned_user_id = ?
                `).get(
                    id,
                    user.company_id,
                    user.id
                );


            if (!lead) {

                return res
                    .status(403)
                    .json({
                        success: false,
                        message:
                            "Nie możesz edytować tego leada."
                    });
            }


            return next();


        } catch (error) {

            console.error(error);


            return res
                .status(500)
                .json({
                    success: false,
                    message:
                        "Błąd sprawdzania uprawnień."
                });
        }
    }
);


// ======================================================
// USER - BRAK USUWANIA LEADÓW
// ======================================================

app.delete(
    "/api/leads/:id",
    wymagajLogowania,
    (req, res, next) => {

        const user =
            pobierzAktualnegoUzytkownika(
                req
            );


        if (!czyUser(user)) {

            return next();
        }


        return res
            .status(403)
            .json({

                success: false,

                message:
                    "USER nie może usuwać leadów."
            });
    }
);


// ======================================================
// USER - BRAK RĘCZNEGO DODAWANIA
// ======================================================

app.post(
    "/api/leads",
    wymagajLogowania,
    (req, res, next) => {

        const user =
            pobierzAktualnegoUzytkownika(
                req
            );


        if (!czyUser(user)) {

            return next();
        }


        return res
            .status(403)
            .json({

                success: false,

                message:
                    "USER nie może ręcznie dodawać leadów."
            });
    }
);


// ======================================================
// USER - STATYSTYKI TYLKO SWOICH LEADÓW
// ======================================================

app.get(
    "/api/stats",
    wymagajLogowania,
    (req, res, next) => {

        try {

            const user =
                pobierzAktualnegoUzytkownika(
                    req
                );


            if (!czyUser(user)) {

                return next();
            }


            const stats =
                db.prepare(`
                    SELECT

                        COUNT(*) AS total,

                        SUM(
                            CASE
                            WHEN klasyfikacja = 'HOT'
                            THEN 1
                            ELSE 0
                            END
                        ) AS hot,

                        SUM(
                            CASE
                            WHEN klasyfikacja = 'WARM'
                            THEN 1
                            ELSE 0
                            END
                        ) AS warm,

                        SUM(
                            CASE
                            WHEN klasyfikacja = 'COLD'
                            THEN 1
                            ELSE 0
                            END
                        ) AS cold

                    FROM leads

                    WHERE
                        company_id = ?
                        AND assigned_user_id = ?
                `).get(
                    user.company_id,
                    user.id
                );


            return res.json({

                success: true,

                stats: {

                    total:
                        stats.total || 0,

                    hot:
                        stats.hot || 0,

                    warm:
                        stats.warm || 0,

                    cold:
                        stats.cold || 0
                }
            });


        } catch (error) {

            console.error(error);


            return res
                .status(500)
                .json({
                    success: false,
                    message:
                        "Nie udało się pobrać statystyk."
                });
        }
    }
);


app.get(
    "/api/leads",
    wymagajLogowania,
    (req, res) => {

        const leady =
            db.prepare(`
                SELECT *
                FROM leads
                WHERE company_id = ?
                ORDER BY score DESC, id DESC
            `).all(
                req.user.companyId
            );


        res.json({
            success: true,
            count:
                leady.length,
            leads:
                leady
        });
    }
);


// ======================================================
// LEADY WYMAGAJĄCE UWAGI
// ======================================================

app.get(
    "/api/leads/attention",
    wymagajLogowania,
    (req, res) => {

        try {

            const leady =
                db.prepare(`
                    SELECT *
                    FROM leads

                    WHERE
                        company_id = ?
                        AND status_obslugi = 'NOWY'
                        AND (
                            klasyfikacja = 'HOT'
                            OR score >= 80
                        )

                    ORDER BY
                        score DESC,
                        data_dodania ASC
                `).all(
                    req.user.companyId
                );


            res.json({

                success: true,

                count:
                    leady.length,

                leads:
                    leady
            });


        } catch (error) {

            console.error(
                "Błąd attention:",
                error
            );


            res.status(500).json({

                success: false,

                message:
                    "Nie udało się pobrać leadów wymagających uwagi."
            });
        }
    }
);



app.get(
    "/api/leads/:id",
    wymagajLogowania,
    (req, res) => {

        const lead =
            db.prepare(`
                SELECT *
                FROM leads

                WHERE
                    id = ?
                    AND company_id = ?
            `).get(
                Number(req.params.id),
                req.user.companyId
            );


        if (!lead) {

            return res
                .status(404)
                .json({
                    success: false,
                    message:
                        "Nie znaleziono leada."
                });
        }


        res.json({
            success: true,
            lead
        });
    }
);


app.get(
    "/api/leads/:id/history",
    wymagajLogowania,
    (req, res) => {

        try {

            const id =
                Number(
                    req.params.id
                );


            if (
                !Number.isInteger(id) ||
                id <= 0
            ) {

                return res
                    .status(400)
                    .json({
                        success: false,
                        message:
                            "Nieprawidłowe ID leada."
                    });
            }


            const user =
                db.prepare(`
                    SELECT
                        id,
                        company_id,
                        rola

                    FROM users

                    WHERE id = ?
                `).get(
                    req.user.userId
                );


            if (!user) {

                return res
                    .status(401)
                    .json({
                        success: false,
                        message:
                            "Użytkownik nie istnieje."
                    });
            }


            let lead;


            if (
                user.rola === "USER"
            ) {

                lead =
                    db.prepare(`
                        SELECT id
                        FROM leads

                        WHERE
                            id = ?
                            AND company_id = ?
                            AND assigned_user_id = ?
                    `).get(
                        id,
                        user.company_id,
                        user.id
                    );

            } else {

                lead =
                    db.prepare(`
                        SELECT id
                        FROM leads

                        WHERE
                            id = ?
                            AND company_id = ?
                    `).get(
                        id,
                        user.company_id
                    );
            }


            if (!lead) {

                return res
                    .status(404)
                    .json({
                        success: false,
                        message:
                            "Nie znaleziono leada lub nie masz do niego dostępu."
                    });
            }


            const historia =
                db.prepare(`
                    SELECT *
                    FROM lead_history

                    WHERE lead_id = ?

                    ORDER BY id DESC
                `).all(
                    id
                );


            return res.json({
                success: true,
                history:
                    historia
            });


        } catch (error) {

            console.error(
                "Historia leada:",
                error
            );


            return res
                .status(500)
                .json({
                    success: false,
                    message:
                        "Nie udało się pobrać historii leada."
                });
        }
    }
);


app.post(
    "/api/leads",
    wymagajLogowania,
    internalLeadsLimiter,
    async (req, res) => {

        try {

         if (
    typeof req.body.wiadomosc !== "string"
) {

    return res
        .status(400)
        .json({
            success: false,
            message:
                "Pole wiadomosc musi być tekstem."
        });
}


const wiadomosc =
    req.body.wiadomosc.trim();


if (wiadomosc.length > 5000) {

    return res
        .status(400)
        .json({
            success: false,
            message:
                "Wiadomość może mieć maksymalnie 5000 znaków."
        });
}


if (!wiadomosc) {

    return res
        .status(400)
        .json({
            success: false,
            message:
                "Wiadomość jest wymagana."
        });
}

            const limit =
                sprawdzLimitLeadowFirmy(
                    req.user.companyId
                );


            if (!limit.allowed) {

                return res
                    .status(403)
                    .json({

                        success: false,

                        code:
                            "PLAN_LEAD_LIMIT_REACHED",

                        message:
                            `Wykorzystano limit ${limit.used}/${limit.limit} leadów dla planu ${limit.plan}. Przejdź na wyższy plan lub poczekaj na nowy okres rozliczeniowy.`,

                        usage:
                            limit
                    });
            }
            if (!wiadomosc) {

                return res
                    .status(400)
                    .json({
                        success: false,
                        message:
                            "Wiadomość jest wymagana."
                    });
            }


            const dane =
                await analizujWiadomosc(
                    wiadomosc
                );

                const limitPoAnalizie =
    sprawdzLimitLeadowFirmy(
        req.user.companyId
    );

if (!limitPoAnalizie.allowed) {

    return res.status(403).json({
        success: false,
        code: "PLAN_LEAD_LIMIT_REACHED",
        message:
            "Limit leadów został osiągnięty."
    });
}

            const lead =
                zapiszLeadaDoFirmy(
                    wiadomosc,
                    dane,
                    req.user.companyId
                );


            res.status(201).json({
                success: true,
                lead
            });


        } catch (error) {

            console.error(error);

            res.status(500).json({
                success: false,
                message:
                    "Nie udało się dodać leada."
            });
        }
    }
);


app.post(
    "/api/external/leads",
    wymagajApiKey,
    externalLeadsLimiter,
    async (req, res) => {

        try {

           if (
    typeof req.body.wiadomosc !== "string"
) {

    return res
        .status(400)
        .json({
            success: false,
            message:
                "Pole wiadomosc musi być tekstem."
        });
}


const wiadomosc =
    req.body.wiadomosc.trim();


if (wiadomosc.length > 5000) {

    return res
        .status(400)
        .json({
            success: false,
            message:
                "Wiadomość może mieć maksymalnie 5000 znaków."
        });
}


if (!wiadomosc) {

                return res
                    .status(400)
                    .json({
                        success: false,
                        message:
                            "Pole wiadomosc jest wymagane."
                    });
            }
            const limit =
                sprawdzLimitLeadowFirmy(
                    req.company.id
                );


            if (!limit.allowed) {

                return res
                    .status(403)
                    .json({

                        success: false,

                        code:
                            "PLAN_LEAD_LIMIT_REACHED",

                        message:
                            `Wykorzystano limit ${limit.used}/${limit.limit} leadów dla planu ${limit.plan}.`,

                        usage:
                            limit
                    });
            }

            const dane =
                await analizujWiadomosc(
                    wiadomosc
                );
            
            const limitPoAnalizie =
    sprawdzLimitLeadowFirmy(
        req.company.id
    );

if (!limitPoAnalizie.allowed) {

    return res.status(403).json({
        success: false,
        code: "PLAN_LEAD_LIMIT_REACHED",
        message:
            "Limit leadów został osiągnięty."
    });
}

            const lead =
                zapiszLeadaDoFirmy(
                    wiadomosc,
                    dane,
                    req.company.id
                );


            res.status(201).json({
                success: true,
                message:
                    "Lead został przyjęty.",
                lead
            });


        } catch (error) {

            console.error(error);

            res.status(500).json({
                success: false,
                message:
                    "Nie udało się przetworzyć leada."
            });
        }
    }
);


app.patch(
    "/api/leads/:id",
    wymagajLogowania,
    (req, res) => {

        const id =
            Number(req.params.id);


        const lead =
            db.prepare(`
                SELECT *
                FROM leads

                WHERE
                    id = ?
                    AND company_id = ?
            `).get(
                id,
                req.user.companyId
            );


        if (!lead) {

            return res
                .status(404)
                .json({
                    success: false,
                    message:
                        "Nie znaleziono leada."
                });
        }

const polaTekstowe = [
    "miasto",
    "waluta",
    "termin_zakupu",
    "poziom_zainteresowania"
];


for (const pole of polaTekstowe) {

    if (
        req.body[pole] !== undefined &&
        req.body[pole] !== null &&
        typeof req.body[pole] !== "string"
    ) {

        return res
            .status(400)
            .json({
                success: false,
                message:
                    `Pole ${pole} musi być tekstem.`
            });
    }
}
        const miasto =
            req.body.miasto ??
            lead.miasto;


        let budzet =
            lead.budzet;


        if (
            req.body.budzet !==
            undefined
        ) {

            if (
                req.body.budzet === "" ||
                req.body.budzet === null
            ) {

                budzet = null;

            } else {

                if (
    typeof req.body.budzet !== "number" &&
    typeof req.body.budzet !== "string"
) {

    return res
        .status(400)
        .json({
            success: false,
            message:
                "Budżet musi być liczbą."
        });
}
                budzet =
                    Number(
                        req.body.budzet
                    );


                if (
                    Number.isNaN(
                        budzet
                    )
                ) {

                    return res
                        .status(400)
                        .json({
                            success: false,
                            message:
                                "Budżet musi być liczbą."
                        });
                }
            }
        }


        const waluta =
            req.body.waluta ??
            lead.waluta;


        const termin =
            req.body.termin_zakupu ??
            lead.termin_zakupu;


        const zainteresowanie =
            req.body.poziom_zainteresowania ??
            lead.poziom_zainteresowania;


        const scoring =
            pobierzScoringFirmy(
                req.user.companyId
            );

        const score =
            policzScore(
                {
                    budzet,
                    termin_zakupu:
                        termin,
                    poziom_zainteresowania:
                        zainteresowanie
                },
                scoring
            );

        const klasyfikacja =
            klasyfikujLeada(
                score,
                scoring
            );


        db.prepare(`
            UPDATE leads
            SET
                miasto = ?,
                budzet = ?,
                waluta = ?,
                termin_zakupu = ?,
                poziom_zainteresowania = ?,
                score = ?,
                klasyfikacja = ?

            WHERE
                id = ?
                AND company_id = ?
        `).run(
            miasto,
            budzet,
                        waluta,
            termin,
            zainteresowanie,
            score,
            klasyfikacja,
            id,
            req.user.companyId
        );


const nowy =
    db.prepare(`
        SELECT *
        FROM leads
        WHERE
            id = ?
            AND company_id = ?
    `).get(
        id,
        req.user.companyId
    );


res.json({
    success: true,
    lead:
        nowy
});
    }
);


app.patch(
    "/api/leads/:id/status",
    wymagajLogowania,
    (req, res) => {

        const id =
            Number(req.params.id);


        const nowyStatus =
            String(
                req.body.status || ""
            )
            .trim()
            .toUpperCase();


        const dozwolone = [
            "NOWY",
            "SKONTAKTOWANO",
            "W TOKU",
            "WYGRANY",
            "ODRZUCONY"
        ];


        if (
            !dozwolone.includes(
                nowyStatus
            )
        ) {

            return res
                .status(400)
                .json({
                    success: false,
                    message:
                        "Nieprawidłowy status."
                });
        }


        const lead =
            db.prepare(`
                SELECT *
                FROM leads

                WHERE
                    id = ?
                    AND company_id = ?
            `).get(
                id,
                req.user.companyId
            );


        if (!lead) {

            return res
                .status(404)
                .json({
                    success: false,
                    message:
                        "Nie znaleziono leada."
                });
        }


        const staryStatus =
            lead.status_obslugi ||
            "NOWY";


        if (
            staryStatus !==
            nowyStatus
        ) {

            db.prepare(`
                UPDATE leads
                SET status_obslugi = ?

                WHERE
                    id = ?
                    AND company_id = ?
            `).run(
                nowyStatus,
                id,
                req.user.companyId
            );


            db.prepare(`
                INSERT INTO lead_history (
                    lead_id,
                    typ,
                    stara_wartosc,
                    nowa_wartosc
                )

                VALUES (?, ?, ?, ?)
            `).run(
                id,
                "STATUS",
                staryStatus,
                nowyStatus
            );
        }


     const nowy =
    db.prepare(`
        SELECT *
        FROM leads
        WHERE
            id = ?
            AND company_id = ?
    `).get(
        id,
        req.user.companyId
    );


res.json({
    success: true,
    lead:
        nowy
});
    }
);


// ======================================================
// USUWANIE LEADA
// ======================================================

app.delete(
    "/api/leads/:id",
    wymagajLogowania,
    (req, res) => {

        const id =
            Number(
                req.params.id
            );


        const lead =
            db.prepare(`
                SELECT *
                FROM leads

                WHERE
                    id = ?
                    AND company_id = ?
            `).get(
                id,
                req.user.companyId
            );


        if (!lead) {

            return res
                .status(404)
                .json({
                    success: false,
                    message:
                        "Nie znaleziono leada."
                });
        }


        db.prepare(`
            DELETE FROM lead_history
            WHERE lead_id = ?
        `).run(
            id
        );


        db.prepare(`
            DELETE FROM leads
            WHERE
                id = ?
                AND company_id = ?
        `).run(
            id,
            req.user.companyId
        );


        res.json({
            success: true,
            message:
                "Lead został usunięty."
        });
    }
);


// ======================================================
// STATYSTYKI
// ======================================================

app.get(
    "/api/stats",
    wymagajLogowania,
    (req, res) => {

        const stats =
            db.prepare(`
                SELECT

                    COUNT(*) AS total,

                    SUM(
                        CASE
                        WHEN klasyfikacja = 'HOT'
                        THEN 1
                        ELSE 0
                        END
                    ) AS hot,

                    SUM(
                        CASE
                        WHEN klasyfikacja = 'WARM'
                        THEN 1
                        ELSE 0
                        END
                    ) AS warm,

                    SUM(
                        CASE
                        WHEN klasyfikacja = 'COLD'
                        THEN 1
                        ELSE 0
                        END
                    ) AS cold

                FROM leads

                WHERE company_id = ?
            `).get(
                req.user.companyId
            );


        res.json({

            success: true,

            stats: {
                total:
                    stats.total || 0,
                hot:
                    stats.hot || 0,
                warm:
                    stats.warm || 0,
                cold:
                    stats.cold || 0
            }
        });
    }
);


// ======================================================
// START
// ======================================================



// ======================================================
// SCORING FIRMY - POBIERANIE
// ======================================================

app.get(
    "/api/company/scoring",
    wymagajLogowania,
    wymagajOwnera,
    (req, res) => {

        try {

            const scoring =
                pobierzScoringFirmy(
                    req.user.companyId
                );


            res.json({

                success: true,

                scoring
            });


        } catch (error) {

            console.error(error);


            res.status(500).json({

                success: false,

                message:
                    "Nie udało się pobrać ustawień scoringu."
            });
        }
    }
);


// ======================================================
// SCORING FIRMY - ZAPIS
// ======================================================

app.patch(
    "/api/company/scoring",
    wymagajLogowania,
    wymagajOwnera,
    (req, res) => {

        try {

            const pola = [
                "budzet_wysoki",
                "budzet_sredni",

                "punkty_budzet_wysoki",
                "punkty_budzet_sredni",
                "punkty_budzet_niski",

                "punkty_termin_szybki",
                "punkty_termin_inny",

                "punkty_zainteresowanie_wysokie",
                "punkty_zainteresowanie_srednie",

                "prog_hot",
                "prog_warm"
            ];


            const dane = {};


            for (const pole of pola) {

                const wartosc =
                    Number(
                        req.body[pole]
                    );


                if (
                    !Number.isFinite(
                        wartosc
                    )
                ) {

                    return res
                        .status(400)
                        .json({

                            success: false,

                            message:
                                `Pole ${pole} musi być liczbą.`
                        });
                }


                dane[pole] =
                    wartosc;
            }


            // ========================================
            // WALIDACJA BUDŻETU
            // ========================================

            if (
                dane.budzet_wysoki <
                dane.budzet_sredni
            ) {

                return res
                    .status(400)
                    .json({

                        success: false,

                        message:
                            "Próg wysokiego budżetu nie może być mniejszy od średniego."
                    });
            }


            if (
                dane.budzet_wysoki < 0 ||
                dane.budzet_sredni < 0
            ) {

                return res
                    .status(400)
                    .json({

                        success: false,

                        message:
                            "Progi budżetu nie mogą być ujemne."
                    });
            }


            // ========================================
            // WALIDACJA PUNKTÓW
            // ========================================

            const polaPunktowe = [

                "punkty_budzet_wysoki",
                "punkty_budzet_sredni",
                "punkty_budzet_niski",

                "punkty_termin_szybki",
                "punkty_termin_inny",

                "punkty_zainteresowanie_wysokie",
                "punkty_zainteresowanie_srednie"
            ];


            for (
                const pole
                of polaPunktowe
            ) {

                if (
                    dane[pole] < 0 ||
                    dane[pole] > 100
                ) {

                    return res
                        .status(400)
                        .json({

                            success: false,

                            message:
                                `${pole} musi być w zakresie 0-100.`
                        });
                }
            }


            // ========================================
            // WALIDACJA HOT / WARM
            // ========================================

            if (
                dane.prog_hot <=
                dane.prog_warm
            ) {

                return res
                    .status(400)
                    .json({

                        success: false,

                        message:
                            "Próg HOT musi być większy od progu WARM."
                    });
            }


            if (
                dane.prog_hot > 100 ||
                dane.prog_hot < 0 ||
                dane.prog_warm > 100 ||
                dane.prog_warm < 0
            ) {

                return res
                    .status(400)
                    .json({

                        success: false,

                        message:
                            "Progi HOT i WARM muszą być w zakresie 0-100."
                    });
            }


            // Upewniamy się, że rekord istnieje

            pobierzScoringFirmy(
                req.user.companyId
            );


            db.prepare(`
                UPDATE company_scoring

                SET
                    budzet_wysoki = ?,
                    budzet_sredni = ?,

                    punkty_budzet_wysoki = ?,
                    punkty_budzet_sredni = ?,
                    punkty_budzet_niski = ?,

                    punkty_termin_szybki = ?,
                    punkty_termin_inny = ?,

                    punkty_zainteresowanie_wysokie = ?,
                    punkty_zainteresowanie_srednie = ?,

                    prog_hot = ?,
                    prog_warm = ?

                WHERE company_id = ?
            `).run(

                dane.budzet_wysoki,
                dane.budzet_sredni,

                dane.punkty_budzet_wysoki,
                dane.punkty_budzet_sredni,
                dane.punkty_budzet_niski,

                dane.punkty_termin_szybki,
                dane.punkty_termin_inny,

                dane.punkty_zainteresowanie_wysokie,
                dane.punkty_zainteresowanie_srednie,

                dane.prog_hot,
                dane.prog_warm,

                req.user.companyId
            );


            const scoring =
                pobierzScoringFirmy(
                    req.user.companyId
                );


            console.log(
                `⚙️ Zmieniono scoring firmy #${req.user.companyId}`
            );


            res.json({

                success: true,

                message:
                    "Ustawienia scoringu zostały zapisane.",

                scoring
            });


        } catch (error) {

            console.error(error);


            res.status(500).json({

                success: false,

                message:
                    "Nie udało się zapisać ustawień scoringu."
            });
        }
    }
);


// ======================================================
// OWNER / ADMIN
// ======================================================

function wymagajOwnerLubAdmin(
    req,
    res,
    next
) {

    try {

        const user =
            db.prepare(`
                SELECT
                    id,
                    company_id,
                    rola

                FROM users

                WHERE id = ?
            `).get(
                req.user.userId
            );


        if (!user) {

            return res
                .status(401)
                .json({
                    success: false,
                    message:
                        "Użytkownik nie istnieje."
                });
        }


        if (
            user.rola !== "OWNER" &&
            user.rola !== "ADMIN"
        ) {

            return res
                .status(403)
                .json({
                    success: false,
                                        message:
                        "Tylko OWNER lub ADMIN może przypisywać leady."
                });
        }


        next();


    } catch (error) {

        console.error(error);


        return res
            .status(500)
            .json({
                success: false,
                message:
                    "Błąd sprawdzania uprawnień."
            });
    }
}


// ======================================================
// PRZYPISANIE LEADA DO PRACOWNIKA
// ======================================================

app.patch(
    "/api/leads/:id/assign",
    wymagajLogowania,
    wymagajOwnerLubAdmin,
    (req, res) => {

        try {

            const leadId =
                Number(
                    req.params.id
                );


            if (
                !Number.isInteger(leadId) ||
                leadId <= 0
            ) {

                return res
                    .status(400)
                    .json({
                        success: false,
                        message:
                            "Nieprawidłowe ID leada."
                    });
            }


            const lead =
                db.prepare(`
                    SELECT *
                    FROM leads

                    WHERE
                        id = ?
                        AND company_id = ?
                `).get(
                    leadId,
                    req.user.companyId
                );


            if (!lead) {

                return res
                    .status(404)
                    .json({
                        success: false,
                        message:
                            "Nie znaleziono leada."
                    });
            }


            const rawUserId =
                req.body.user_id;


            let userId = null;
            let nowyPracownik = null;


            if (
                rawUserId !== null &&
                rawUserId !== undefined &&
                rawUserId !== ""
            ) {

                userId =
                    Number(rawUserId);


                if (
                    !Number.isInteger(userId) ||
                    userId <= 0
                ) {

                    return res
                        .status(400)
                        .json({
                            success: false,
                            message:
                                "Nieprawidłowe ID pracownika."
                        });
                }


                nowyPracownik =
                    db.prepare(`
                        SELECT
                            id,
                            imie,
                            email,
                            rola

                        FROM users

                        WHERE
                            id = ?
                            AND company_id = ?
                    `).get(
                        userId,
                        req.user.companyId
                    );


                if (!nowyPracownik) {

                    return res
                        .status(404)
                        .json({
                            success: false,
                            message:
                                "Pracownik nie należy do tej firmy."
                        });
                }
            }


            let staryPracownik = null;


            if (
                lead.assigned_user_id
            ) {

                staryPracownik =
                    db.prepare(`
                        SELECT
                            id,
                            imie,
                            email

                        FROM users

                        WHERE id = ?
                    `).get(
                        lead.assigned_user_id
                    );
            }


            db.prepare(`
                UPDATE leads

                SET assigned_user_id = ?

                WHERE
                    id = ?
                    AND company_id = ?
            `).run(
                userId,
                leadId,
                req.user.companyId
            );


            db.prepare(`
                INSERT INTO lead_history (
                    lead_id,
                    typ,
                    stara_wartosc,
                    nowa_wartosc
                )

                VALUES (?, ?, ?, ?)
            `).run(

                leadId,

                "PRZYPISANIE",

                staryPracownik
                    ? (
                        staryPracownik.imie ||
                        staryPracownik.email
                    )
                    : "BRAK",

                nowyPracownik
                    ? (
                        nowyPracownik.imie ||
                        nowyPracownik.email
                    )
                    : "BRAK"
            );


            const aktualnyLead =
                db.prepare(`
                    SELECT
                        leads.*,

                        users.imie
                            AS assigned_user_name,

                        users.email
                            AS assigned_user_email,

                        users.rola
                            AS assigned_user_role

                    FROM leads

                    LEFT JOIN users
                        ON users.id =
                           leads.assigned_user_id

                    WHERE
                        leads.id = ?
                        AND leads.company_id = ?
                `).get(
                    leadId,
                    req.user.companyId
                );


            res.json({

                success: true,

                message:
                    userId
                        ? "Lead został przypisany."
                        : "Przypisanie leada zostało usunięte.",

                lead:
                    aktualnyLead
            });


        } catch (error) {

            console.error(
                "Błąd przypisywania:",
                error
            );


            res.status(500).json({
                success: false,
                message:
                    "Nie udało się przypisać leada."
            });
        }
    }
);


// ======================================================
// MOJE LEADY
// ======================================================

app.get(
    "/api/my-leads",
    wymagajLogowania,
    (req, res) => {

        try {

            const leady =
                db.prepare(`
                    SELECT
                        leads.*,

                        users.imie
                            AS assigned_user_name,

                        users.email
                            AS assigned_user_email

                    FROM leads

                    LEFT JOIN users
                        ON users.id =
                           leads.assigned_user_id

                    WHERE
                        leads.company_id = ?
                        AND leads.assigned_user_id = ?

                    ORDER BY
                        CASE leads.klasyfikacja
                            WHEN 'HOT' THEN 1
                            WHEN 'WARM' THEN 2
                            ELSE 3
                        END,

                        leads.score DESC,
                        leads.id DESC
                `).all(
                    req.user.companyId,
                    req.user.userId
                );


            res.json({

                success: true,

                count:
                    leady.length,

                leads:
                    leady
            });


        } catch (error) {

            console.error(
                "Błąd moje leady:",
                error
            );


            res.status(500).json({

                success: false,

                message:
                    "Nie udało się pobrać Twoich leadów."
            });
        }
    }
);


// ======================================================
// LEAD + INFORMACJA O PRACOWNIKU
// OWNER / ADMIN = dowolny lead firmy
// USER = tylko lead przypisany do niego
// ======================================================

app.get(
    "/api/leads-assigned/:id",
    wymagajLogowania,
    (req, res) => {

        try {

            const id =
                Number(
                    req.params.id
                );


            if (
                !Number.isInteger(id) ||
                id <= 0
            ) {

                return res
                    .status(400)
                    .json({
                        success: false,
                        message:
                            "Nieprawidłowe ID leada."
                    });
            }


            const user =
                db.prepare(`
                    SELECT
                        id,
                        company_id,
                        rola

                    FROM users

                    WHERE id = ?
                `).get(
                    req.user.userId
                );


            if (!user) {

                return res
                    .status(401)
                    .json({
                        success: false,
                        message:
                            "Użytkownik nie istnieje."
                    });
            }


            let lead;


            if (
                user.rola === "USER"
            ) {

                lead =
                    db.prepare(`
                        SELECT
                            leads.*,

                            users.imie
                                AS assigned_user_name,

                            users.email
                                AS assigned_user_email,

                            users.rola
                                AS assigned_user_role

                        FROM leads

                        LEFT JOIN users
                            ON users.id =
                               leads.assigned_user_id

                        WHERE
                            leads.id = ?
                            AND leads.company_id = ?
                            AND leads.assigned_user_id = ?
                    `).get(
                        id,
                        user.company_id,
                        user.id
                    );

            } else {

                lead =
                    db.prepare(`
                        SELECT
                            leads.*,

                            users.imie
                                AS assigned_user_name,

                            users.email
                                AS assigned_user_email,

                            users.rola
                                AS assigned_user_role

                        FROM leads

                        LEFT JOIN users
                            ON users.id =
                               leads.assigned_user_id

                        WHERE
                            leads.id = ?
                            AND leads.company_id = ?
                    `).get(
                        id,
                        user.company_id
                    );
            }


            if (!lead) {

                return res
                    .status(404)
                    .json({
                        success: false,
                        message:
                            "Nie znaleziono leada lub nie masz do niego dostępu."
                    });
            }


            return res.json({
                success: true,
                lead
            });


        } catch (error) {

            console.error(
                "Lead assigned:",
                error
            );


            return res
                .status(500)
                .json({
                    success: false,
                    message:
                        "Nie udało się pobrać leada."
                });
        }
    }
);

// ======================================================
// UŻYTKOWNICY DO PRZYPISYWANIA LEADÓW
// OWNER + ADMIN
// ======================================================

app.get(
    "/api/company/assignable-users",
    wymagajLogowania,
    wymagajOwnerLubAdmin,
    (req, res) => {

        try {

            const users =
                db.prepare(`
                    SELECT
                        id,
                        imie,
                        email,
                        rola

                    FROM users

                    WHERE company_id = ?

                    ORDER BY
                        CASE rola
                            WHEN 'OWNER' THEN 1
                            WHEN 'ADMIN' THEN 2
                            ELSE 3
                        END,
                        imie ASC
                `).all(
                    req.user.companyId
                );


            res.json({

                success: true,

                count:
                    users.length,

                users
            });


        } catch (error) {

            console.error(
                "Assignable users:",
                error
            );


            res.status(500).json({

                success: false,

                message:
                    "Nie udało się pobrać użytkowników."
            });
        }
    }
);


// ======================================================
// LEAD_ANALYZER_CHANGE_PASSWORD_V1
// ZMIANA WŁASNEGO HASŁA
// ======================================================

app.patch(
    "/api/me/password",
    wymagajLogowania,
    async (req, res) => {

        try {

            const {
                currentPassword,
                newPassword
            } = req.body;

if (
    typeof currentPassword !== "string" ||
    typeof newPassword !== "string" ||
    !currentPassword ||
    !newPassword
) {

    return res
        .status(400)
        .json({
            success: false,
            message:
                "Podaj prawidłowe obecne i nowe hasło."
        });
}


          if (
    newPassword.length < 8
) {

                return res
                    .status(400)
                    .json({

                        success: false,

                        message:
                            "Nowe hasło musi mieć minimum 8 znaków."
                    });
            }


            if (
                currentPassword === newPassword
            ) {

                return res
                    .status(400)
                    .json({

                        success: false,

                        message:
                            "Nowe hasło musi być inne niż obecne."
                    });
            }


            const user =
                db.prepare(`
                    SELECT *
                    FROM users
                    WHERE id = ?
                `).get(
                    req.user.userId
                );


            if (!user) {

                return res
                    .status(404)
                    .json({

                        success: false,

                        message:
                            "Nie znaleziono użytkownika."
                    });
            }


            const passwordHash =
                user.haslo_hash ??
                user.haslo ??
                user.password_hash ??
                user.password;


            if (!passwordHash) {

                return res
                    .status(500)
                    .json({

                        success: false,

                        message:
                            "Nie znaleziono hasła użytkownika w bazie."
                    });
            }


            const poprawneHaslo =
                await bcrypt.compare(
                    currentPassword,
                    passwordHash
                );


            if (!poprawneHaslo) {

                return res
                    .status(400)
                                        .json({

                        success: false,

                        message:
                            "Obecne hasło jest nieprawidłowe."
                    });
            }


            // ==========================================
            // NOWY HASH
            // ==========================================

            const newHash =
                await bcrypt.hash(
                    newPassword,
                    12
                );


            // ==========================================
            // USTALENIE KOLUMNY
            // ==========================================

           const columns =
    db.prepare(
        "PRAGMA table_info(users)"
    ).all();


const columnNames =
    columns.map(
        column => column.name
    );


let passwordColumn = null;


if (
    columnNames.includes(
        "haslo_hash"
    )
) {

    passwordColumn =
        "haslo_hash";

} else if (
    columnNames.includes(
        "haslo"
    )
) {

    passwordColumn =
        "haslo";

} else if (
    columnNames.includes(
        "password_hash"
    )
) {

    passwordColumn =
        "password_hash";

} else if (
    columnNames.includes(
        "password"
    )
) {

    passwordColumn =
        "password";
}


if (!passwordColumn) {

    return res
        .status(500)
        .json({

            success: false,

            message:
                "Nie znaleziono kolumny hasła."
        });
}
            // ==========================================
            // ZAPIS
            // ==========================================

          db.prepare(`
    UPDATE users

    SET
        ${passwordColumn} = ?,
        token_version = token_version + 1

    WHERE id = ?
`).run(
    newHash,
    user.id
);


            console.log(
                "🔐 Zmieniono hasło użytkownika:",
                user.email
            );


            return res.json({

                success: true,

                message:
                    "Hasło zostało zmienione."
            });


        } catch (error) {

            console.error(
                "Zmiana hasła:",
                error
            );


            return res
                .status(500)
                .json({

                    success: false,

                    message:
                        "Nie udało się zmienić hasła."
                });
        }
    }
);

// ======================================================
// PLAN FIRMY / WYKORZYSTANIE LIMITÓW
// ======================================================

app.get(
    "/api/company/plan",
    wymagajLogowania,
    (req, res) => {

        try {

            const plan =
                db.prepare(`
                    SELECT
                        p.*

                    FROM companies c

                    JOIN plans p
                        ON p.id = c.plan_id

                    WHERE c.id = ?
                `).get(
                    req.user.companyId
                );


            if (!plan) {

                return res
                    .status(404)
                    .json({

                        success: false,

                        message:
                            "Firma nie ma przypisanego planu."
                    });
            }


            const liczbaUserow =
                db.prepare(`
                    SELECT COUNT(*) AS count

                    FROM users

                    WHERE company_id = ?
                `).get(
                    req.user.companyId
                ).count;


           const firmaBilling =
    db.prepare(`
        SELECT
            billing_period_start,
            billing_period_end
        FROM companies
        WHERE id = ?
    `).get(
        req.user.companyId
    );


            const leadUsage =
                sprawdzLimitLeadowFirmy(
                    req.user.companyId
                );


            const liczbaLeadow =
                leadUsage.used;


            const limitLeadow =
                plan.limit_leadow ??
                plan.limit_leads ??
                plan.lead_limit ??
                null;


            const limitUserow =
                plan.limit_userow ??
                plan.limit_users ??
                plan.user_limit ??
                null;


            return res.json({

                success: true,

                plan,

                usage: {

                    users: {

                        used:
                            Number(
                                liczbaUserow
                            ) || 0,

                        limit:
                            limitUserow,

                        remaining:
                            limitUserow === null
                                ? null
                                : Math.max(
                                    Number(
                                        limitUserow
                                    ) -
                                    (
                                        Number(
                                            liczbaUserow
                                        ) || 0
                                    ),
                                    0
                                )
                    },


                    leads: {

                        used:
                            Number(
                                liczbaLeadow
                            ) || 0,

                        limit:
                            limitLeadow,

                        remaining:
                            limitLeadow === null
                                ? null
                                : Math.max(
                                    Number(
                                        limitLeadow
                                    ) -
                                    (
                                        Number(
                                            liczbaLeadow
                                        ) || 0
                                    ),
                                    0
                                )
                    }
                }
            });


        } catch (error) {

            console.error(
                "Pobieranie planu firmy:",
                error
            );


            return res
                .status(500)
                .json({

                    success: false,

                    message:
                        "Nie udało się pobrać planu firmy."
                });
        }
    }
);

// ======================================================
// ZMIANA PLANU FIRMY + HISTORIA
// ======================================================

app.patch(
    "/api/company/plan",
    wymagajLogowania,
    wymagajOwnera,
    (req, res) => {

        try {
            if (
                process.env.BILLING_TEST_MODE !== "true"
            ) {

                return res
                    .status(403)
                    .json({
                        success: false,
                        message:
                            "Bezpośrednia zmiana planu jest wyłączona. Plan może zostać aktywowany wyłącznie po potwierdzeniu płatności."
                    });
            }
            const kod =
                String(
                    req.body.kod || ""
                )
                .trim()
                .toUpperCase();


            if (
                ![
                    "STARTER",
                    "PRO",
                    "BUSINESS",
                    "CUSTOM"
                ].includes(kod)
            ) {

                return res
                    .status(400)
                    .json({
                        success: false,
                        message:
                            "Nieprawidłowy plan."
                    });
            }


            const nowyPlan =
                db.prepare(`
                    SELECT *
                    FROM plans
                    WHERE
                        kod = ?
                        AND aktywny = 1
                `).get(kod);


            if (!nowyPlan) {

                return res
                    .status(404)
                    .json({
                        success: false,
                        message:
                            "Nie znaleziono aktywnego planu."
                    });
            }


            const firma =
                db.prepare(`
                    SELECT
                        id,
                        plan_id
                    FROM companies
                    WHERE id = ?
                `).get(
                    req.user.companyId
                );


            if (!firma) {

                return res
                    .status(404)
                    .json({
                        success: false,
                        message:
                            "Nie znaleziono firmy."
                    });
            }


            if (
                Number(firma.plan_id) ===
                Number(nowyPlan.id)
            ) {

                return res
                    .status(400)
                    .json({
                        success: false,
                        message:
                            "Firma korzysta już z tego planu."
                    });
            }


            const zmienPlan =
                db.transaction(() => {

                    db.prepare(`
                        UPDATE companies
                        SET
                            plan_id = ?,
                            subscription_status = 'ACTIVE',
                            billing_period_start = CURRENT_TIMESTAMP,
                            billing_period_end = datetime(
                                CURRENT_TIMESTAMP,
                                '+1 month'
                            )
                        WHERE id = ?
                    `).run(
                        nowyPlan.id,
                        req.user.companyId
                    );


                    db.prepare(`
                        INSERT INTO plan_history (
                            company_id,
                            user_id,
                            old_plan_id,
                            new_plan_id,
                            source
                        )
                        VALUES (?, ?, ?, ?, ?)
                    `).run(
                        req.user.companyId,
                        req.user.userId,
                        firma.plan_id,
                        nowyPlan.id,
                        "MANUAL"
                    );
                });


            zmienPlan();


            return res.json({
                success: true,
                message:
                    `Plan został zmieniony na ${nowyPlan.kod}.`,
                plan:
                    nowyPlan
            });


        } catch (error) {

            console.error(
                "Zmiana planu:",
                error
            );


            return res
                .status(500)
                .json({
                    success: false,
                    message:
                        "Nie udało się zmienić planu."
                });
        }
    }
);
// ======================================================
// ROZLICZENIA FIRMY
// ======================================================

app.get(
    "/api/company/billing",
    wymagajLogowania,
    wymagajOwnera,
    (req, res) => {

        try {

            const billing =
                db.prepare(`
                    SELECT
                        c.id AS company_id,
                        c.nazwa AS company_name,

                        c.subscription_status,
                        c.billing_period_start,
                        c.billing_period_end,
                        c.trial_ends_at,

                        p.id AS plan_id,
                        p.kod AS plan_code,
                        p.nazwa AS plan_name,
                        p.cena_miesieczna,
                        p.cena_wdrozenia,
                        p.limit_leadow,
                        p.limit_userow

                    FROM companies c

                    LEFT JOIN plans p
                        ON p.id = c.plan_id

                    WHERE c.id = ?
                `).get(
                    req.user.companyId
                );


            if (!billing) {

                return res
                    .status(404)
                    .json({
                        success: false,
                        message:
                            "Nie znaleziono danych rozliczeniowych."
                    });
            }


            const historia =
                db.prepare(`
                    SELECT
                        ph.id,
                        ph.source,
                        ph.data_zmiany,

                        oldp.kod AS old_plan,
                        newp.kod AS new_plan,

                        u.imie AS changed_by_name,
                        u.email AS changed_by_email

                    FROM plan_history ph

                    LEFT JOIN plans oldp
                        ON oldp.id = ph.old_plan_id

                    LEFT JOIN plans newp
                        ON newp.id = ph.new_plan_id

                    LEFT JOIN users u
                        ON u.id = ph.user_id

                    WHERE ph.company_id = ?

                    ORDER BY
                        ph.id DESC

                    LIMIT 20
                `).all(
                    req.user.companyId
                );


            return res.json({

                success: true,

                billing,

                history:
                    historia
            });


        } catch (error) {

            console.error(
                "Billing:",
                error
            );


            return res
                .status(500)
                .json({
                    success: false,
                    message:
                        "Nie udało się pobrać danych rozliczeniowych."
                });
        }
    }
);
// ======================================================
// BILLING CHECKOUT
// ======================================================

app.post(
    "/api/billing/checkout",
    wymagajLogowania,
    wymagajOwnera,
    (req, res) => {

        try {

            const kod =
                String(
                    req.body.kod || ""
                )
                .trim()
                .toUpperCase();


            if (
                ![
                    "STARTER",
                    "PRO",
                    "BUSINESS"
                ].includes(kod)
            ) {

                return res
                    .status(400)
                    .json({
                        success: false,
                        message:
                            "Nieprawidłowy plan."
                    });
            }


            const plan =
                db.prepare(`
                    SELECT *
                    FROM plans
                    WHERE
                        kod = ?
                        AND aktywny = 1
                `).get(kod);


            if (!plan) {

                return res
                    .status(404)
                    .json({
                        success: false,
                        message:
                            "Nie znaleziono aktywnego planu."
                    });
            }


            const firma =
                db.prepare(`
                    SELECT
                        id,
                        plan_id
                    FROM companies
                    WHERE id = ?
                `).get(
                    req.user.companyId
                );


            if (!firma) {

                return res
                    .status(404)
                    .json({
                        success: false,
                        message:
                            "Nie znaleziono firmy."
                    });
            }


            if (
                Number(firma.plan_id) ===
                Number(plan.id)
            ) {

                return res
                    .status(400)
                    .json({
                        success: false,
                        message:
                            "Firma korzysta już z tego planu."
                    });
            }


            const checkoutToken =
                crypto
                    .randomBytes(32)
                    .toString("hex");


            const wynik =
                db.prepare(`
                    INSERT INTO payments (
                        company_id,
                        user_id,
                        plan_id,
                        status,
                        amount,
                        setup_amount,
                        currency,
                        provider,
                        checkout_token
                    )
                    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
                `).run(
                    req.user.companyId,
                    req.user.userId,
                    plan.id,
                    "PENDING",
                    plan.cena_miesieczna,
                    plan.cena_wdrozenia,
                    "PLN",
                    "TEST",
                    checkoutToken
                );


            const payment =
                db.prepare(`
                    SELECT
                        payments.*,
                        plans.kod AS plan_code,
                        plans.nazwa AS plan_name

                    FROM payments

                    JOIN plans
                        ON plans.id =
                           payments.plan_id

                    WHERE payments.id = ?
                `).get(
                    wynik.lastInsertRowid
                );


            return res
                .status(201)
                .json({
                    success: true,
                    message:
                        "Checkout został utworzony.",
                    payment
                });


        } catch (error) {

            console.error(
                "Billing checkout:",
                error
            );


            return res
                .status(500)
                .json({
                    success: false,
                    message:
                        "Nie udało się utworzyć checkoutu."
                });
        }
    }
);
// ======================================================
// TESTOWE POTWIERDZENIE PŁATNOŚCI
// ======================================================

app.post(
    "/api/billing/test-confirm/:id",
    wymagajLogowania,
    wymagajOwnera,
    (req, res) => {

        try {
            if (
                process.env.BILLING_TEST_MODE !== "true"
            ) {

                return res
                    .status(404)
                    .json({
                        success: false,
                        message:
                            "Endpoint testowy jest wyłączony."
                    });
            }
            const paymentId =
                Number(
                    req.params.id
                );


            if (
                !Number.isInteger(paymentId) ||
                paymentId <= 0
            ) {

                return res
                    .status(400)
                    .json({
                        success: false,
                        message:
                            "Nieprawidłowe ID płatności."
                    });
            }


            const payment =
                db.prepare(`
                    SELECT
                        payments.*,

                        plans.kod AS plan_code

                    FROM payments

                    JOIN plans
                        ON plans.id =
                           payments.plan_id

                    WHERE
                        payments.id = ?
                        AND payments.company_id = ?
                `).get(
                    paymentId,
                    req.user.companyId
                );


            if (!payment) {

                return res
                    .status(404)
                    .json({
                        success: false,
                        message:
                            "Nie znaleziono płatności."
                    });
            }


            if (
                payment.status !==
                "PENDING"
            ) {

                return res
                    .status(400)
                    .json({
                        success: false,
                        message:
                            "Ta płatność nie oczekuje już na potwierdzenie."
                    });
            }


            const firma =
                db.prepare(`
                    SELECT
                        id,
                        plan_id

                    FROM companies

                    WHERE id = ?
                `).get(
                    req.user.companyId
                );


            if (!firma) {

                return res
                    .status(404)
                    .json({
                        success: false,
                        message:
                            "Nie znaleziono firmy."
                    });
            }


            const potwierdz =
                db.transaction(() => {

                    db.prepare(`
                        UPDATE payments

                        SET
                            status = 'PAID',
                            paid_at = CURRENT_TIMESTAMP

                        WHERE id = ?
                    `).run(
                        payment.id
                    );


                    db.prepare(`
                        UPDATE companies

                        SET
                            plan_id = ?,
                            subscription_status = 'ACTIVE',
                            billing_period_start =
                                CURRENT_TIMESTAMP,
                            billing_period_end =
                                datetime(
                                    CURRENT_TIMESTAMP,
                                    '+1 month'
                                )

                        WHERE id = ?
                    `).run(
                        payment.plan_id,
                        req.user.companyId
                    );


                    db.prepare(`
                        INSERT INTO plan_history (
                            company_id,
                            user_id,
                            old_plan_id,
                            new_plan_id,
                            source
                        )

                        VALUES (?, ?, ?, ?, ?)
                    `).run(
                        req.user.companyId,
                        req.user.userId,
                        firma.plan_id,
                        payment.plan_id,
                        "PAYMENT"
                    );
                });


            potwierdz();


            const aktualnaPlatnosc =
                db.prepare(`
                    SELECT *
                    FROM payments
                    WHERE id = ?
                `).get(
                    payment.id
                );


            return res.json({

                success: true,

                message:
                    `Płatność potwierdzona. Plan ${payment.plan_code} został aktywowany.`,

                payment:
                    aktualnaPlatnosc
            });


        } catch (error) {

            console.error(
                "Test confirm payment:",
                error
            );


            return res
                .status(500)
                .json({
                    success: false,
                    message:
                        "Nie udało się potwierdzić płatności."
                });
        }
    }
);
// ======================================================
// TESTOWE POTWIERDZENIE PŁATNOŚCI
// ======================================================

// ======================================================
// HISTORIA PŁATNOŚCI FIRMY
// ======================================================

app.get(
    "/api/company/payments",
    wymagajLogowania,
    wymagajOwnera,
    (req, res) => {

        try {

            const payments =
                db.prepare(`
                    SELECT
                        payments.id,
                        payments.status,
                        payments.amount,
                        payments.setup_amount,
                        payments.currency,
                        payments.provider,
                        payments.created_at,
                        payments.paid_at,
                        payments.canceled_at,

                        plans.kod AS plan_code,
                        plans.nazwa AS plan_name

                    FROM payments

                    JOIN plans
                        ON plans.id =
                           payments.plan_id

                    WHERE
                        payments.company_id = ?

                    ORDER BY
                        payments.id DESC

                    LIMIT 50
                `).all(
                    req.user.companyId
                );


            return res.json({

                success: true,

                payments
            });


        } catch (error) {

            console.error(
                "Historia płatności:",
                error
            );


            return res
                .status(500)
                .json({
                    success: false,
                    message:
                        "Nie udało się pobrać historii płatności."
                });
        }
    }
);
app.listen(PORT, () => {

    console.log("");
    console.log("================================");
    console.log("       LEAD ANALYZER SaaS");
    console.log("================================");

    console.log(
        `🚀 http://localhost:${PORT}`
    );

    console.log("");

    console.log(
        "👥 GET    /api/company/users"
    );

    console.log(
        "➕ POST   /api/company/users"
    );

    console.log(
        "🛡️ PATCH  /api/company/users/:id/role"
    );

    console.log(
        "🗑️ DELETE /api/company/users/:id"
    );

    console.log("");

    console.log(
        "🔑 GET  /api/company/api-key"
    );

    console.log(
        "🔄 POST /api/company/api-key/regenerate"
    );

    console.log("");

    console.log(
        "📦 GET  /api/company/plan"
    );

    console.log(
        "🌐 POST /api/external/leads"
    );

    console.log(
        "💳 GET  /api/company/billing"
    );

    console.log(
        "💰 GET  /api/company/payments"
    );

    console.log("");
    console.log("================================");
    console.log("");
});