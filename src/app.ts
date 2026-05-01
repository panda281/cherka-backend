import cors from "cors";
import express from "express";
import helmet from "helmet";
import morgan from "morgan";
import path from "node:path";
import { eventsRouter } from "./modules/events/routes";
import { ordersRouter } from "./modules/orders/routes";
import { adminReceiptsRouter } from "./modules/receipts/adminRoutes";
import { telegramRouter } from "./modules/telegram/routes";
import { checkinRouter } from "./modules/checkin/routes";

export const app = express();

app.use(helmet());
app.use(cors());
app.use(morgan("dev"));
app.use(express.json({ limit: "2mb" }));
app.use("/uploads", express.static(path.resolve("uploads")));

app.get("/health", (_req, res) => {
  res.json({ ok: true });
});

app.use(eventsRouter);
app.use(ordersRouter);
app.use(adminReceiptsRouter);
app.use(telegramRouter);
app.use(checkinRouter);

app.use((err: Error, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
  res.status(500).json({ error: err.message });
});
