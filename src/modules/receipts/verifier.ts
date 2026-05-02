import { config } from "../../config";
import { buildReceiptUrl } from "../../utils";
import { logReceiptVerify } from "./verifyLogging";

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

/** Match Telebirr `credited_party_name` to `TELEBIRR_RECEIVER_NAME` (ignore case, trim, collapse spaces). */
function normalizeCreditedPartyName(s: string): string {
  return s
    .trim()
    .replace(/\s+/g, " ")
    .toLowerCase();
}

/** Telebirr API: compare order total to `data.amount` only (not `total_paid`). */
function paidAmountFromTelebirrData(data: Record<string, unknown>): number | null {
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
      logReceiptVerify("telebirr_api_request", {
        receiptNo: input.receiptNo,
        expectedAmount: input.expectedAmount,
        urlHost: (() => {
          try {
            return new URL(url).host;
          } catch {
            return "invalid-url";
          }
        })()
      });

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
        logReceiptVerify("telebirr_api_http_error", {
          receiptNo: input.receiptNo,
          httpStatus: response.status,
          detail: detail.slice(0, 400)
        });
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
        return {
          ok: false,
          mode: "parser",
          notes: "Verify API: missing or invalid `data.amount` on receipt (total_paid is not used).",
          receiptUrl
        };
      }

      const expected = input.expectedAmount;
      if (Math.abs(paid - expected) > 0.02) {
        logReceiptVerify("telebirr_api_amount_mismatch", {
          receiptNo: input.receiptNo,
          receiptAmountField: paid,
          expectedOrderAmount: expected
        });
        return {
          ok: false,
          mode: "parser",
          notes: `Amount mismatch: receipt \`amount\` is ${paid} ETB, order expects ${expected} ETB.`,
          receiptUrl
        };
      }

      const nameRaw = data.credited_party_name;
      const creditedName =
        typeof nameRaw === "string"
          ? nameRaw.trim()
          : typeof nameRaw === "number"
            ? String(nameRaw).trim()
            : "";

      if (!config.receiptVerifySkipReceiverCheck) {
        if (!creditedName) {
          return {
            ok: false,
            mode: "parser",
            notes:
              "Verify API: missing `data.credited_party_name` on receipt (receiver is matched by credited name, not phone).",
            receiptUrl
          };
        }
        const expectedName = input.receiverName.trim();
        if (!expectedName) {
          return {
            ok: false,
            mode: "parser",
            notes: "Server misconfiguration: TELEBIRR_RECEIVER_NAME is empty (needed to match credited_party_name).",
            receiptUrl
          };
        }
        if (normalizeCreditedPartyName(creditedName) !== normalizeCreditedPartyName(expectedName)) {
          logReceiptVerify("telebirr_api_receiver_name_mismatch", {
            receiptNo: input.receiptNo,
            creditedPartyName: creditedName,
            expectedReceiverName: expectedName
          });
          return {
            ok: false,
            mode: "parser",
            notes: `Credited party name mismatch: receipt has "${creditedName}", expected "${expectedName}" (case-insensitive). Set TELEBIRR_RECEIVER_NAME to match the Telebirr receiver display name, or RECEIPT_VERIFY_SKIP_RECEIVER_CHECK=true only for demos.`,
            receiptUrl
          };
        }
      }

      const payer =
        typeof data.payer_name === "string" && data.payer_name.trim()
          ? data.payer_name.trim()
          : typeof data.payer_phone === "string"
            ? data.payer_phone
            : "unknown";

      logReceiptVerify("telebirr_api_auto_approve_ok", {
        receiptNo: input.receiptNo,
        amountField: paid,
        expectedAmount: input.expectedAmount,
        payer
      });
      return {
        ok: true,
        mode: "parser",
        notes: `Auto-verified via Telebirr API. Paid ${paid} ETB. Payer: ${payer}.`,
        receiptUrl
      };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      logReceiptVerify("telebirr_api_exception", { receiptNo: input.receiptNo, error: msg });
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
    logReceiptVerify("verify_skip_external_api", {
      receiptNo: input.receiptNo,
      skipExternalApi: Boolean(options.skipExternalApi),
      hasVerifyUrl: Boolean(config.receiptVerifyTelebirrUrl)
    });
    const manual = await new ManualReceiptVerifier().verify(input);
    logReceiptVerify("verify_resolve_result", {
      receiptNo: input.receiptNo,
      ok: manual.ok,
      mode: manual.mode,
      notes: manual.notes.slice(0, 500)
    });
    return manual;
  }
  const result = await new ParserReceiptVerifier().verify(input);
  logReceiptVerify("verify_resolve_result", {
    receiptNo: input.receiptNo,
    ok: result.ok,
    mode: result.mode,
    notes: result.notes.slice(0, 500)
  });
  return result;
}
