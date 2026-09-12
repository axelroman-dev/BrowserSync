ALTER TABLE "users" ADD COLUMN "passphrase_verifier_hash" text NOT NULL;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "dek_envelope_ciphertext" text NOT NULL;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "dek_envelope_iv" text NOT NULL;