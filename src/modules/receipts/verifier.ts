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
    return {
      ok: false,
      mode: "parser",
      notes:
        "Parser adapter placeholder. Integrate BirrVerify/custom parser to auto-validate transaction details.",
      receiptUrl: buildReceiptUrl(input.receiptNo)
    };
  }
}

export function getVerifier(mode: "manual" | "parser"): ReceiptVerifier {
  return mode === "parser" ? new ParserReceiptVerifier() : new ManualReceiptVerifier();
}
