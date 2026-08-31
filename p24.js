const crypto = require("crypto");


// ======================================================
// KONFIGURACJA
// ======================================================

const MODE =
    process.env.P24_MODE || "sandbox";


const BASE_URL =
    MODE === "production"
        ? "https://secure.przelewy24.pl"
        : "https://sandbox.przelewy24.pl";


const MERCHANT_ID =
    Number(
        process.env.P24_MERCHANT_ID
    );


const POS_ID =
    Number(
        process.env.P24_POS_ID ||
        process.env.P24_MERCHANT_ID
    );


const CRC =
    process.env.P24_CRC;


const API_KEY =
    process.env.P24_API_KEY;


// ======================================================
// BASIC AUTH
// ======================================================

function authHeader() {

    const token =
        Buffer.from(
            `${POS_ID}:${API_KEY}`
        ).toString(
            "base64"
        );


    return `Basic ${token}`;
}


// ======================================================
// SHA-384
// ======================================================

function sha384(
    value
) {

    return crypto
        .createHash(
            "sha384"
        )
        .update(
            value
        )
        .digest(
            "hex"
        );
}


// ======================================================
// SIGN - REGISTER
// ======================================================

function registerSign({
    sessionId,
    amount,
    currency
}) {

    const data = {

        sessionId:
            String(sessionId),

        merchantId:
            MERCHANT_ID,

        amount:
            Number(amount),

        currency:
            String(currency),

        crc:
            CRC
    };


    return sha384(
        JSON.stringify(
            data
        )
    );
}


// ======================================================
// SIGN - VERIFY
// ======================================================

function verifySign({
    sessionId,
    orderId,
    amount,
    currency
}) {

    const data = {

        sessionId:
            String(sessionId),

        orderId:
            Number(orderId),

        amount:
            Number(amount),

        currency:
            String(currency),

        crc:
            CRC
    };


    return sha384(
        JSON.stringify(
            data
        )
    );
}


// ======================================================
// TEST DOSTĘPU
// ======================================================

async function testAccess() {

    const response =
        await fetch(
            `${BASE_URL}/api/v1/testAccess`,
            {
                method:
                    "GET",

                headers: {
                    Authorization:
                        authHeader()
                }
            }
        );


    const data =
        await response.json();


    if (!response.ok) {

        throw new Error(
            JSON.stringify(
                data
            )
        );
    }


    return data;
}


// ======================================================
// REJESTRACJA TRANSAKCJI
// ======================================================

async function registerTransaction({
    sessionId,
    amount,
    currency = "PLN",
    description,
    email,
    urlReturn,
    urlStatus
}) {

    const sign =
        registerSign({
            sessionId,
            amount,
            currency
        });


    const payload = {

        merchantId:
            MERCHANT_ID,

        posId:
            POS_ID,

        sessionId:
            String(sessionId),

        amount:
            Number(amount),

        currency:
            currency,

        description:
            description,

        email:
            email,

        country:
            "PL",

        language:
            "pl",

        urlReturn:
            urlReturn,

        urlStatus:
            urlStatus,

        waitForResult:
            true,

        sign
    };


    const response =
        await fetch(
            `${BASE_URL}/api/v1/transaction/register`,
            {
                method:
                    "POST",

                headers: {

                    Authorization:
                        authHeader(),

                    "Content-Type":
                        "application/json"
                },

                body:
                    JSON.stringify(
                        payload
                    )
            }
        );


    const data =
        await response.json();


    if (!response.ok) {

        throw new Error(
            JSON.stringify(
                data
            )
        );
    }


    return data;
}


// ======================================================
// WERYFIKACJA TRANSAKCJI
// ======================================================

async function verifyTransaction({
    sessionId,
    orderId,
    amount,
    currency = "PLN"
}) {

    const sign =
        verifySign({
            sessionId,
            orderId,
            amount,
            currency
        });


    const payload = {

        merchantId:
            MERCHANT_ID,

        posId:
            POS_ID,

        sessionId:
            String(sessionId),

        amount:
            Number(amount),

        currency:
            currency,

        orderId:
            Number(orderId),

        sign
    };


    const response =
        await fetch(
            `${BASE_URL}/api/v1/transaction/verify`,
            {
                method:
                    "PUT",

                headers: {

                    Authorization:
                        authHeader(),

                    "Content-Type":
                        "application/json"
                },

                body:
                    JSON.stringify(
                        payload
                    )
            }
        );


    const data =
        await response.json();


    if (!response.ok) {

        throw new Error(
            JSON.stringify(
                data
            )
        );
    }


    return data;
}


module.exports = {

    BASE_URL,

    testAccess,

    registerTransaction,

    verifyTransaction
};