const readline = require("readline");

const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout
});

function ocenKlienta(klient) {
    if (klient.budzet >= 500000 && klient.zainteresowany === true) {
        return "🔥 HOT LEAD";
    } else if (klient.budzet >= 300000 && klient.zainteresowany === true) {
        return "🟡 WARM LEAD";
    } else {
        return "🔵 COLD LEAD";
    }
}

function wyswietlRaport(klient, status) {
    console.log("");
    console.log("========================");
    console.log("     LEAD ANALYZER");
    console.log("========================");
    console.log(`Imię: ${klient.imie}`);
    console.log(`Miasto: ${klient.miasto}`);
    console.log(`Budżet: ${klient.budzet} zł`);
    console.log(`Zainteresowany: ${klient.zainteresowany ? "Tak" : "Nie"}`);
    console.log(`STATUS: ${status}`);
    console.log("========================");
}

rl.question("Jak masz na imię? ", (imie) => {
    rl.question("W jakim mieście mieszkasz? ", (miasto) => {
        rl.question("Jaki jest Twój budżet? ", (budzet) => {
            budzet = Number(budzet);

            rl.question("Czy jesteś zainteresowany zakupem? (tak/nie) ", (odpowiedz) => {
                let zainteresowany = odpowiedz.toLowerCase() === "tak";

                let klient = {
                    imie: imie,
                    miasto: miasto,
                    budzet: budzet,
                    zainteresowany: zainteresowany
                };

                let status = ocenKlienta(klient);

                wyswietlRaport(klient, status);

                rl.close();
            });
        });
    });
});