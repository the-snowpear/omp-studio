import "reflect-metadata";
import { randomBytes, X509Certificate } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  BasicConstraintsExtension, ExtendedKeyUsage, ExtendedKeyUsageExtension,
  KeyUsageFlags, KeyUsagesExtension, SubjectAlternativeNameExtension, X509CertificateGenerator,
} from "@peculiar/x509";

interface MobileCertificate {
  ip: string;
  key: string;
  cert: string;
  authority: string;
}

const signingAlgorithm = { name: "ECDSA", namedCurve: "P-256", hash: "SHA-256" };

export async function getMobileCertificate(directory: string, ip: string): Promise<MobileCertificate> {
  const path = join(directory, "mobile-https.json");
  const saved = await readFile(path, "utf8").catch((error: NodeJS.ErrnoException) => {
    if (error.code !== "ENOENT") throw error;
    return undefined;
  });
  if (saved !== undefined) {
    const material = JSON.parse(saved) as MobileCertificate;
    const certificate = new X509Certificate(material.cert);
    if (material.ip === ip && certificate.checkIP(ip) && Date.parse(certificate.validTo) > Date.now()) return material;
  }

  const authorityKey = await crypto.subtle.generateKey(signingAlgorithm, false, ["sign", "verify"]);
  const serverKey = await crypto.subtle.generateKey(signingAlgorithm, true, ["sign", "verify"]);
  const notBefore = new Date(Date.now() - 300_000);
  const notAfter = new Date(Date.now() + 365 * 24 * 60 * 60 * 1000);
  const subject = `CN=OMP Studio Mobile ${randomBytes(4).toString("hex")}`;
  const certificateOptions = { notBefore, notAfter, signingAlgorithm };
  const authority = await X509CertificateGenerator.createSelfSigned({
    ...certificateOptions,
    serialNumber: randomBytes(16).toString("hex"),
    name: subject,
    keys: authorityKey,
    extensions: [
      new BasicConstraintsExtension(true, 0, true),
      new KeyUsagesExtension(KeyUsageFlags.keyCertSign | KeyUsageFlags.cRLSign, true),
    ],
  });
  const certificate = await X509CertificateGenerator.create({
    ...certificateOptions,
    serialNumber: randomBytes(16).toString("hex"),
    subject: `CN=${ip}`,
    issuer: authority.subject,
    signingKey: authorityKey.privateKey,
    publicKey: serverKey.publicKey,
    extensions: [
      new BasicConstraintsExtension(false, undefined, true),
      new KeyUsagesExtension(KeyUsageFlags.digitalSignature, true),
      new ExtendedKeyUsageExtension([ExtendedKeyUsage.serverAuth]),
      new SubjectAlternativeNameExtension([{ type: "ip", value: ip }]),
    ],
  });
  const privateDer = await crypto.subtle.exportKey("pkcs8", serverKey.privateKey);
  const privatePem = Buffer.from(privateDer).toString("base64").match(/.{1,64}/g)!.join("\n");
  const material = {
    ip,
    key: `-----BEGIN PRIVATE KEY-----\n${privatePem}\n-----END PRIVATE KEY-----\n`,
    cert: certificate.toString("pem"),
    authority: authority.toString("pem"),
  };
  await mkdir(directory, { recursive: true, mode: 0o700 });
  await writeFile(path, JSON.stringify(material), { mode: 0o600 });
  return material;
}
