require("dotenv").config();

const OpenAI = require("openai");
const readline = require("readline");

const client = new OpenAI({
    apiKey: process.env.OPENAI_API_KEY
});

const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout
});

async function main() {

    rl.question("Wpisz wiadomość klienta: ", async (wiadomoscKlienta) => {

        try {

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

                Jeżeli jakiejś informacji nie ma w wiadomości,
                wpisz null.

                Wiadomość klienta:
                ${wiadomoscKlienta}
                `
            });

            const tekstAI = response.output_text;

            console.log("ODPOWIEDŹ AI:");
            console.log(tekstAI);

            const daneKlienta = JSON.parse(tekstAI);

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

            console.log("");
            console.log("================================");
            console.log("       WYNIK ANALIZY LEADA");
            console.log("================================");
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

        } catch (error) {

            console.log("\n❌ WYSTĄPIŁ BŁĄD:");
            console.log(error.message);

        } finally {

            rl.close();

        }
    });
}

main();