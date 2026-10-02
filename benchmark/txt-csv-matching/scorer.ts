import type { Scorer } from "../../src/scorer.js";

const scorer: Scorer = {
  async score(_output, caseId) {
    throw new Error(`txt-csv-matching: scorer is not implemented yet (${caseId})`);
  },
};

export default scorer;
