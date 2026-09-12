import {
  pgTable,
  uuid,
  text,
  timestamp,
  integer,
  unique,
  uniqueIndex,
  index,
  check,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";

/**
 * Email is stored as typed-in (mixed case preserved for display) but made
 * unique case-insensitively via a functional index on lower(email), so
 * Axel@x.com and axel@x.com can't both register. This avoids depending on
 * the citext extension, which some managed/locked-down Postgres instances
 * don't allow installing.
 */
/**
 * dekEnvelope* / passphraseVerifierHash implement envelope encryption for the
 * "unlock with your password, recover with your passphrase" design:
 *
 * - A random Data Encryption Key (DEK) - generated client-side, never
 *   derived from anything guessable - is the key that actually encrypts
 *   sync blobs. It's never sent to the server in raw form.
 * - dekEnvelopeCiphertext/Iv is the DEK wrapped (AES-GCM) with a key derived
 *   from the user's PASSPHRASE. It's safe to store here: unwrapping it
 *   requires the passphrase, which the server never learns in any form.
 *   This is what lets a new device (or a password reset) recover the DEK.
 * - passwordHash is for login, completely unrelated to the DEK. Each
 *   device additionally keeps its OWN wrapping of the DEK under a
 *   password-derived key, but that copy lives ONLY in that device's local
 *   extension storage - never here - which is exactly what keeps
 *   "unlock with your password" from letting the server (which does see
 *   the password on every login) reconstruct the DEK on its own: it has
 *   the key but not the box.
 * - passphraseVerifierHash is an argon2 hash of a value derived from the
 *   passphrase via a DIFFERENT PBKDF2 salt than the one used for the DEK
 *   wrapping key (see extension/lib/crypto.js). It lets /auth/reset-password
 *   confirm "this caller knows the passphrase" without ever letting the
 *   server learn the passphrase itself or anything that helps unwrap
 *   dekEnvelopeCiphertext.
 */
export const users = pgTable(
  "users",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    email: text("email").notNull(),
    // argon2id hash string (includes algorithm, salt and params) - never a raw password.
    passwordHash: text("password_hash").notNull(),
    passphraseVerifierHash: text("passphrase_verifier_hash").notNull(),
    dekEnvelopeCiphertext: text("dek_envelope_ciphertext").notNull(),
    dekEnvelopeIv: text("dek_envelope_iv").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [uniqueIndex("users_email_lower_idx").on(sql`lower(${table.email})`)],
);

/**
 * One row per logged-in device. A device presents its raw refresh token to
 * /api/auth/refresh; we only ever store its hash, so a leaked database dump
 * doesn't hand out working credentials. Deleting/expiring one row logs out
 * exactly one device, which is what lets a single account span several
 * machines (personal laptop, work laptop, ...) safely.
 */
export const refreshTokens = pgTable(
  "refresh_tokens",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    tokenHash: text("token_hash").notNull().unique(),
    deviceLabel: text("device_label"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    lastUsedAt: timestamp("last_used_at", { withTimezone: true }),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
  },
  (table) => [index("refresh_tokens_user_id_idx").on(table.userId)],
);

/**
 * One row per (user, data_type). The server never decrypts `ciphertext` -
 * it is opaque AES-GCM output produced client-side. `version` implements
 * optimistic concurrency: a client must present the version it last saw to
 * overwrite the row, so two devices syncing close together can't silently
 * clobber each other (see syncService for the merge-and-retry flow this
 * enables client-side).
 */
export const syncBlobs = pgTable(
  "sync_blobs",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    dataType: text("data_type").notNull(),
    ciphertext: text("ciphertext").notNull(),
    iv: text("iv").notNull(),
    version: integer("version").notNull().default(1),
    clientUpdatedAt: timestamp("client_updated_at", { withTimezone: true }).notNull(),
    sizeBytes: integer("size_bytes").notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    unique("sync_blobs_user_id_data_type_unique").on(table.userId, table.dataType),
    index("sync_blobs_user_id_idx").on(table.userId),
    check(
      "sync_blobs_data_type_check",
      sql`${table.dataType} IN ('bookmarks', 'history', 'extensions')`,
    ),
  ],
);

export type User = typeof users.$inferSelect;
export type RefreshToken = typeof refreshTokens.$inferSelect;
export type SyncBlob = typeof syncBlobs.$inferSelect;
