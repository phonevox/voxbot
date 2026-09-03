import crypto from "crypto";

const ALGORITHM = "aes-256-ctr";
const IV_LENGTH = 16;

function getKey(): Buffer {
	return crypto
		.createHash("sha256")
		.update(process.env.ENCRYPTION_KEY!)
		.digest();
}

export function encrypt(text: string): string {
	const iv = crypto.randomBytes(IV_LENGTH);
	const cipher = crypto.createCipheriv(ALGORITHM, getKey(), iv);

	const encrypted = Buffer.concat([
		cipher.update(text, "utf8"),
		cipher.final(),
	]);

	return iv.toString("hex") + ":" + encrypted.toString("hex");
}

export function decrypt(text: string): string {
	const [ivHex, encryptedHex] = text.split(":");

	const iv = Buffer.from(ivHex, "hex");
	const encrypted = Buffer.from(encryptedHex, "hex");

	const decipher = crypto.createDecipheriv(ALGORITHM, getKey(), iv);

	const decrypted = Buffer.concat([
		decipher.update(encrypted),
		decipher.final(),
	]);

	return decrypted.toString("utf8");
}
