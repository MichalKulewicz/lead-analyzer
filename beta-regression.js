const BASE = "http://localhost:3000";
const PASSWORD = "BetaRegression2026!";

let passed = 0;
let failed = 0;
let testNo = 0;

let ownerToken = null;
let adminToken = null;
let userToken = null;
let companyId = null;
let leadId = null;

const stamp = Date.now();
const ownerEmail = `beta-owner-${stamp}@test.pl`;
const adminEmail = `beta-admin-${stamp}@test.pl`;
const userEmail = `beta-user-${stamp}@test.pl`;

function pass(name) {
    testNo++;
    passed++;
    console.log(`PASS ${String(testNo).padStart(2, "0")} | ${name}`);
}

function fail(name, details = "") {
    testNo++;
    failed++;
    console.log(`FAIL ${String(testNo).padStart(2, "0")} | ${name}`);

    if (details) {
        console.log(`         ${details}`);
    }
}

async function request(path, options = {}) {
    const headers = {
        ...(options.headers || {})
    };

    if (
        options.body !== undefined &&
        !headers["Content-Type"]
    ) {
        headers["Content-Type"] = "application/json";
    }

    const response = await fetch(BASE + path, {
        method: options.method || "GET",
        headers,
        body:
            options.body === undefined
                ? undefined
                : JSON.stringify(options.body)
    });

    let body = null;

    try {
        body = await response.json();
    } catch {
        body = null;
    }

    return {
        status: response.status,
        body
    };
}

function auth(token) {
    return {
        Authorization: `Bearer ${token}`
    };
}

async function run() {
    console.log("");
    console.log("========================================");
    console.log("       FINAL BETA REGRESSION");
    console.log("========================================");
    console.log("");

    // 01
    {
        const r = await request("/");

        if (r.status === 200) {
            pass("Frontend odpowiada");
        } else {
            fail("Frontend odpowiada", `HTTP ${r.status}`);
        }
    }

    // 02
    {
        const r = await request(
            "/api/endpoint-that-does-not-exist"
        );

        if (r.status === 404) {
            pass("Nieistniejący endpoint zwraca 404");
        } else {
            fail(
                "Nieistniejący endpoint zwraca 404",
                `HTTP ${r.status}`
            );
        }
    }

    // 03
    {
        const r = await request("/api/register", {
            method: "POST",
            body: {
                nazwaFirmy: `Beta Regression ${stamp}`,
                imie: "Owner",
                email: ownerEmail,
                haslo: PASSWORD
            }
        });

        if (
            r.status === 201 &&
            r.body?.token &&
            r.body?.user?.rola === "OWNER"
        ) {
            ownerToken = r.body.token;
            companyId = r.body.user.companyId;

            pass("Rejestracja tworzy OWNER-a");
        } else {
            fail(
                "Rejestracja tworzy OWNER-a",
                `HTTP ${r.status} | ${JSON.stringify(r.body)}`
            );
        }
    }

    // 04
    {
        const r = await request("/api/register", {
            method: "POST",
            body: {
                nazwaFirmy: "Bad Password",
                imie: "Test",
                email: `short-${stamp}@test.pl`,
                haslo: "1234567"
            }
        });

        if (r.status === 400) {
            pass("Hasło < 8 znaków jest odrzucane");
        } else {
            fail(
                "Hasło < 8 znaków jest odrzucane",
                `HTTP ${r.status}`
            );
        }
    }

    // 05
    {
        const r = await request("/api/register", {
            method: "POST",
            body: {
                nazwaFirmy: "Long Password",
                imie: "Test",
                email: `long-${stamp}@test.pl`,
                haslo: "a".repeat(129)
            }
        });

        if (r.status === 400) {
            pass("Hasło > 128 znaków jest odrzucane");
        } else {
            fail(
                "Hasło > 128 znaków jest odrzucane",
                `HTTP ${r.status}`
            );
        }
    }

    // 06
    {
        const r = await request("/api/login", {
            method: "POST",
            body: {
                email: ownerEmail,
                haslo: PASSWORD
            }
        });

        if (r.status === 200 && r.body?.token) {
            ownerToken = r.body.token;
            pass("OWNER może się zalogować");
        } else {
            fail(
                "OWNER może się zalogować",
                `HTTP ${r.status}`
            );
        }
    }

    // 07
    {
        const r = await request("/api/login", {
            method: "POST",
            body: {
                email: ownerEmail,
                haslo: "ZleHaslo123!"
            }
        });

        if (r.status === 401) {
            pass("Błędne hasło logowania jest odrzucane");
        } else {
            fail(
                "Błędne hasło logowania jest odrzucane",
                `HTTP ${r.status}`
            );
        }
    }

    // 08
    {
        const r = await request("/api/me", {
            headers: auth(ownerToken)
        });

        if (
            r.status === 200 &&
            r.body?.user?.rola === "OWNER" &&
            Number(r.body?.user?.company_id) === Number(companyId)
        ) {
            pass("/api/me zwraca właściwego OWNER-a");
        } else {
            fail(
                "/api/me zwraca właściwego OWNER-a",
                `HTTP ${r.status} | ${JSON.stringify(r.body)}`
            );
        }
    }

    // TEST SETUP: plan PRO potrzebny do testów ADMIN + USER
    {
        const r = await request("/api/company/plan", {
            method: "PATCH",
            headers: auth(ownerToken),
            body: {
                kod: "PRO"
            }
        });

        if (r.status !== 200) {
            console.error(
                "FATAL: Nie udało się ustawić planu PRO dla testowej firmy."
            );
            console.error(
                `HTTP ${r.status} | ${JSON.stringify(r.body)}`
            );
            console.error(
                "Uruchom serwer developerski z BILLING_TEST_MODE=true."
            );
            process.exitCode = 1;
            return;
        }
    }

    // 09
    {
        const r = await request("/api/company/users", {
            method: "POST",
            headers: auth(ownerToken),
            body: {
                imie: "Admin",
                email: adminEmail,
                haslo: PASSWORD,
                rola: "ADMIN"
            }
        });

        if (r.status === 201) {
            pass("OWNER może utworzyć ADMIN-a");
        } else {
            fail(
                "OWNER może utworzyć ADMIN-a",
                `HTTP ${r.status} | ${JSON.stringify(r.body)}`
            );
        }
    }

    // 10
    {
        const r = await request("/api/company/users", {
            method: "POST",
            headers: auth(ownerToken),
            body: {
                imie: "User",
                email: userEmail,
                haslo: PASSWORD,
                rola: "USER"
            }
        });

        if (r.status === 201) {
            pass("OWNER może utworzyć USER-a");
        } else {
            fail(
                "OWNER może utworzyć USER-a",
                `HTTP ${r.status} | ${JSON.stringify(r.body)}`
            );
        }
    }

    // 11
    {
        const r = await request("/api/login", {
            method: "POST",
            body: {
                email: adminEmail,
                haslo: PASSWORD
            }
        });

        if (
            r.status === 200 &&
            r.body?.token &&
            r.body?.user?.rola === "ADMIN"
        ) {
            adminToken = r.body.token;
            pass("ADMIN może się zalogować");
        } else {
            fail(
                "ADMIN może się zalogować",
                `HTTP ${r.status}`
            );
        }
    }

    // 12
    {
        const r = await request("/api/login", {
            method: "POST",
            body: {
                email: userEmail,
                haslo: PASSWORD
            }
        });

        if (
            r.status === 200 &&
            r.body?.token &&
            r.body?.user?.rola === "USER"
        ) {
            userToken = r.body.token;
            pass("USER może się zalogować");
        } else {
            fail(
                "USER może się zalogować",
                `HTTP ${r.status}`
            );
        }
    }

    // 13
    {
        const r = await request("/api/company/users", {
            headers: auth(ownerToken)
        });

        const serialized = JSON.stringify(r.body);

        if (
            r.status === 200 &&
            serialized.includes(adminEmail) &&
            serialized.includes(userEmail)
        ) {
            pass("OWNER widzi użytkowników swojej firmy");
        } else {
            fail(
                "OWNER widzi użytkowników swojej firmy",
                `HTTP ${r.status}`
            );
        }
    }

    // 14
    {
        const r = await request("/api/company/scoring", {
            headers: auth(ownerToken)
        });

        if (r.status === 200) {
            pass("OWNER może pobrać scoring");
        } else {
            fail(
                "OWNER może pobrać scoring",
                `HTTP ${r.status}`
            );
        }
    }

    // 15
    {
        const r = await request("/api/company/scoring", {
            headers: auth(adminToken)
        });

        if (r.status === 403) {
            pass("ADMIN nie może zarządzać scoringiem");
        } else {
            fail(
                "ADMIN nie może zarządzać scoringiem",
                `HTTP ${r.status}`
            );
        }
    }

    // 16
    {
        const r = await request("/api/company/api-key", {
            headers: auth(userToken)
        });

        if (r.status === 403) {
            pass("USER nie może pobrać API key");
        } else {
            fail(
                "USER nie może pobrać API key",
                `HTTP ${r.status}`
            );
        }
    }

    // 17
    {
        const r = await request("/api/leads", {
            method: "POST",
            headers: auth(userToken),
            body: {
                wiadomosc:
                    "Szukam mieszkania w Warszawie do 800000 zł."
            }
        });

        if (r.status === 403) {
            pass("USER nie może ręcznie dodać leada");
        } else {
            fail(
                "USER nie może ręcznie dodać leada",
                `HTTP ${r.status}`
            );
        }
    }

    // 18
    {
        const r = await request("/api/leads", {
            method: "POST",
            headers: auth(ownerToken),
            body: {
                wiadomosc:
                    "Szukam mieszkania w Warszawie do 800000 zł, zakup w tym miesiącu."
            }
        });

        if (
            r.status === 201 &&
            r.body?.lead?.id
        ) {
            leadId = r.body.lead.id;
            pass("OWNER może utworzyć leada");
        } else {
            fail(
                "OWNER może utworzyć leada",
                `HTTP ${r.status} | ${JSON.stringify(r.body)}`
            );
        }
    }

    // 19
    {
        const r = await request("/api/leads", {
            headers: auth(ownerToken)
        });

        const leads =
            Array.isArray(r.body?.leads)
                ? r.body.leads
                : [];

        const found =
            leads.some(lead =>
                Number(lead.id) === Number(leadId)
            );

        if (r.status === 200 && found) {
            pass("Utworzony lead jest na liście firmy");
        } else {
            fail(
                "Utworzony lead jest na liście firmy",
                `HTTP ${r.status}`
            );
        }
    }

    // 20
    {
        const r = await request(
            `/api/leads/${leadId}`,
            {
                headers: auth(ownerToken)
            }
        );

        if (
            r.status === 200 &&
            Number(r.body?.lead?.id) === Number(leadId)
        ) {
            pass("Można pobrać własnego leada");
        } else {
            fail(
                "Można pobrać własnego leada",
                `HTTP ${r.status}`
            );
        }
    }

    // 21
    {
        const r = await request("/api/stats", {
            headers: auth(ownerToken)
        });

        if (r.status === 200) {
            pass("Statystyki firmy działają");
        } else {
            fail(
                "Statystyki firmy działają",
                `HTTP ${r.status}`
            );
        }
    }

    // 22
    {
        const r = await request(
            `/api/leads/${leadId}/history`,
            {
                headers: auth(ownerToken)
            }
        );

        if (r.status === 200) {
            pass("Historia własnego leada działa");
        } else {
            fail(
                "Historia własnego leada działa",
                `HTTP ${r.status}`
            );
        }
    }

    // 23
    {
        const r = await request("/api/company/plan", {
            headers: auth(ownerToken)
        });

        if (r.status === 200) {
            pass("Informacje o planie firmy działają");
        } else {
            fail(
                "Informacje o planie firmy działają",
                `HTTP ${r.status}`
            );
        }
    }

    // 24
    {
        const r = await request("/api/company/billing", {
            headers: auth(ownerToken)
        });

        if (r.status === 200) {
            pass("Billing firmy działa");
        } else {
            fail(
                "Billing firmy działa",
                `HTTP ${r.status}`
            );
        }
    }

    console.log("");
    console.log("========================================");
    console.log(`FINAL: ${passed}/${testNo} PASS`);

    if (failed === 0 && testNo === 24) {
        console.log("STATUS: ALL TESTS PASSED");
    } else {
        console.log(`STATUS: ${failed} TEST(S) FAILED`);
        process.exitCode = 1;
    }

    console.log("========================================");
    console.log("");
}

run().catch(error => {
    console.error("");
    console.error("FATAL REGRESSION ERROR:");
    console.error(error);
    process.exitCode = 1;
});
