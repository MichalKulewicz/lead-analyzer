const fs = require("fs");
const path = require("path");
const Database = require("better-sqlite3");

const SOURCE =
    path.join(__dirname, "leads.db");

const BACKUP_DIR =
    path.join(__dirname, "backups");

const MAX_BACKUPS = 14;


function timestamp() {
    return new Date()
        .toISOString()
        .replace(/[:.]/g, "-");
}


async function main() {

    if (!fs.existsSync(SOURCE)) {
        throw new Error(
            "Nie znaleziono leads.db."
        );
    }


    fs.mkdirSync(
        BACKUP_DIR,
        { recursive: true }
    );


    const sourceDb =
        new Database(
            SOURCE,
            { readonly: true }
        );


    try {

        const integrity =
            sourceDb.pragma(
                "integrity_check",
                { simple: true }
            );


        if (integrity !== "ok") {
            throw new Error(
                `Baza źródłowa nie przeszła integrity_check: ${integrity}`
            );
        }


        const backupName =
            `leads-${timestamp()}.db`;

        const backupPath =
            path.join(
                BACKUP_DIR,
                backupName
            );


        console.log(
            "Tworzenie backupu:",
            backupName
        );


        await sourceDb.backup(
            backupPath
        );


        const backupDb =
            new Database(
                backupPath,
                { readonly: true }
            );


        try {

            const backupIntegrity =
                backupDb.pragma(
                    "integrity_check",
                    { simple: true }
                );


            if (backupIntegrity !== "ok") {
                throw new Error(
                    `Backup nie przeszedł integrity_check: ${backupIntegrity}`
                );
            }

        } finally {
            backupDb.close();
        }


        const backups =
            fs.readdirSync(BACKUP_DIR)
                .filter(
                    name =>
                        /^leads-.*\.db$/.test(name)
                )
                .sort()
                .reverse();


        for (
            const oldBackup
            of backups.slice(MAX_BACKUPS)
        ) {

            fs.unlinkSync(
                path.join(
                    BACKUP_DIR,
                    oldBackup
                )
            );

            console.log(
                "Usunięto stary backup:",
                oldBackup
            );
        }


        console.log(
            "✅ Backup utworzony i zweryfikowany."
        );

        console.log(
            "Plik:",
            backupPath
        );


    } finally {

        sourceDb.close();
    }
}


main().catch(error => {

    console.error(
        "❌ Backup failed:",
        error.message
    );

    process.exitCode = 1;
});
