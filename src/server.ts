import { app } from "./app";
import { config } from "./config";

app.listen(config.port, () => {
  // eslint-disable-next-line no-console
  console.log(`API running at http://localhost:${config.port}`);
});
