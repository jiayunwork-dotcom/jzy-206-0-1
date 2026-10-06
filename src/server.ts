import { createApplicationWithServices } from './app.js';

const port = Number(process.env.PORT ?? 3000);
const { app } = await createApplicationWithServices();

app.listen(port, () => {
  console.log(`Availability service listening on port ${port}`);
});
