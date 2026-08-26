let klient = {
    imie: "Michal",
    miasto: "Warszawa",
    budzet: 200000,
    zainteresowany: true
};

console.log(klient);
console.log(klient.imie);
console.log(klient.miasto);
console.log(klient.budzet);
if (klient.budzet >= 500000 && klient.zainteresowany === true) {
    console.log("HOT LEAD");
} else if (klient.budzet >= 300000 && klient.zainteresowany === true) {
    console.log("WARM LEAD");
} else {
    console.log("COLD LEAD");
}