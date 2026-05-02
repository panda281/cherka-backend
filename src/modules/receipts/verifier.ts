import { config } from "../../config";
import { buildReceiptUrl } from "../../utils";

export type ReceiptVerificationInput = {
  receiptNo: string;
  expectedAmount: number;
  receiverNumber: string;
  receiverName: string;
};

export type ReceiptVerificationResult = {
  ok: boolean;
  mode: "manual" | "parser";
  notes: string;
  receiptUrl: string;
};

export interface ReceiptVerifier {
  verify(input: ReceiptVerificationInput): Promise<ReceiptVerificationResult>;
}

function normalizeEthioPhone(raw: string | null | undefined): string {
  if (!raw) return "";
  const digits = raw.replace(/\D/g, "");
  if (digits.startsWith("251") && digits.length >= 12) {
    return `0${digits.slice(3)}`;
  }
  return digits;
}

/** Compare Telebirr-style accounts (+251… vs 09…). */
function ethioReceiverMatches(apiValue: string, configuredReceiver: string): boolean {
  const a = normalizeEthioPhone(apiValue).replace(/\D/g, "");
  const b = normalizeEthioPhone(configuredReceiver).replace(/\D/g, "");
  if (!a || !b) return false;
  if (a === b) return true;
  const tail = (s: string) => (s.length >= 9 ? s.slice(-9) : s);
  return tail(a) === tail(b);
}

function paidAmountFromTelebirrData(data: Record<string, unknown>): number | null {
  const total = data.total_paid;
  if (total != null && total !== "") {
    const n = Number(total);
    if (Number.isFinite(n)) return n;
  }
  const amt = data.amount;
  if (amt != null && amt !== "") {
    const n = Number(amt);
    if (Number.isFinite(n)) return n;
  }
  return null;
}

export class ManualReceiptVerifier implements ReceiptVerifier {
  async verify(input: ReceiptVerificationInput): Promise<ReceiptVerificationResult> {
    return {
      ok: false,
      mode: "manual",
      notes:
        "Manual review required: confirm amount, receiver account/name, transaction time, and non-duplicate proof.",
      receiptUrl: buildReceiptUrl(input.receiptNo)
    };
  }
}

export class ParserReceiptVerifier implements ReceiptVerifier {
  async verify(input: ReceiptVerificationInput): Promise<ReceiptVerificationResult> {
    const receiptUrl = buildReceiptUrl(input.receiptNo);
    const url = config.receiptVerifyTelebirrUrl;
    if (!url) {
      return {
        ok: false,
        mode: "parser",
        notes: "Set RECEIPT_VERIFY_TELEBIRR_URL to enable Telebirr receipt API verification.",
        receiptUrl
      };
    }

    try {
      const response = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json", Accept: "application/json" },
        body: JSON.stringify({ receipt_no: input.receiptNo }),
        signal: AbortSignal.timeout(Math.max(1000, config.receiptVerifyTimeoutMs))
      });

      const rawText = await response.text();
      let json: unknown;
      try {
        json = rawText ? JSON.parse(rawText) : {};
      } catch {
        return {
          ok: false,
          mode: "parser",
          notes: `Verify API returned non-JSON (HTTP ${response.status}).`,
          receiptUrl
        };
      }

      if (!response.ok) {
        const detail =
          typeof json === "object" && json !== null && "detail" in json
            ? String((json as { detail: unknown }).detail)
            : rawText.slice(0, 500);
        return {
          ok: false,
          mode: "parser",
          notes: `Verify API HTTP ${response.status}: ${detail}`,
          receiptUrl
        };
      }

      if (typeof json !== "object" || json === null) {
        return { ok: false, mode: "parser", notes: "Verify API: invalid response body.", receiptUrl };
      }

      const body = json as { status?: string; data?: Record<string, unknown> | null };
      const data = body.data;
      if (!data || typeof data !== "object") {
        return {
          ok: false,
          mode: "parser",
          notes: `Verify API: no receipt data (status=${String(body.status ?? "?")}).`,
          receiptUrl
        };
      }

      const paid = paidAmountFromTelebirrData(data);
      if (paid == null) {
        return { ok: false, mode: "parser", notes: "Verify API: could not read paid amount from receipt.", receiptUrl };
      }

      const expected = input.expectedAmount;
      if (Math.abs(paid - expected) > 0.02) {
        return {
          ok: false,
          mode: "parser",
          notes: `Amount mismatch: receipt shows ${paid} ETB, order expects ${expected} ETB.`,
          receiptUrl
        };
      }

      const creditedRaw = data.credited_party_account_no;
      const hasCredited =
        typeof creditedRaw === "string" || typeof creditedRaw === "number"
          ? String(creditedRaw).trim().length > 0
          : false;

      if (
        !config.receiptVerifySkipReceiverCheck &&
        hasCredited &&
        !ethioReceiverMatches(String(creditedRaw), input.receiverNumber)
      ) {
        return {
          ok: false,
          mode: "parser",
          notes: `Receiver mismatch: receipt credits ${String(creditedRaw)}, expected ${input.receiverNumber}. Set RECEIPT_VERIFY_SKIP_RECEIVER_CHECK=true only for demos.`,
          receiptUrl
        };
      }

      const payer =
        typeof data.payer_name === "string" && data.payer_name.trim()
          ? data.payer_name.trim()
          : typeof data.payer_phone === "string"
            ? data.payer_phone
            : "unknown";

      return {
        ok: true,
        mode: "parser",
        notes: `Auto-verified via Telebirr API. Paid ${paid} ETB. Payer: ${payer}.`,
        receiptUrl
      };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return {
        ok: false,
        mode: "parser",
        notes: `Verify API request failed: ${msg}`,
        receiptUrl
      };
    }
  }
}

export function getVerifier(mode: "manual" | "parser"): ReceiptVerifier {
  return mode === "parser" ? new ParserReceiptVerifier() : new ManualReceiptVerifier();
}

/**
 * When `RECEIPT_VERIFY_TELEBIRR_URL` is set and `skipExternalApi` is false, calls the external Telebirr verify endpoint.
 * Otherwise queues for manual review (same as manual verifier).
 */
export async function resolveReceiptVerification(
  input: ReceiptVerificationInput,
  options: { skipExternalApi?: boolean } = {}
): Promise<ReceiptVerificationResult> {
  if (options.skipExternalApi || !config.receiptVerifyTelebirrUrl) {
    return new ManualReceiptVerifier().verify(input);
  }
  return new ParserReceiptVerifier().verify(input);
}
