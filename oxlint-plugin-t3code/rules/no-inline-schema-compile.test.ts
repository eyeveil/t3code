import { assert, describe } from "@effect/vitest";

import { createOxlintRuleHarness } from "../test/utils.ts";

const rule = createOxlintRuleHarness("t3code/no-inline-schema-compile");

describe("t3code/no-inline-schema-compile", () => {
  rule.valid(
    "allows schema compilers hoisted to module scope",
    `
      import { Schema } from "effect";

      const User = Schema.Struct({ name: Schema.String });
      const decodeUser = Schema.decodeUnknownEffect(User);

      export const parseUser = (input: unknown) => decodeUser(input);
    `,
  );

  rule.invalid(
    "reports schema compilers inside function bodies",
    `
      import { Schema } from "effect";

      const User = Schema.Struct({ name: Schema.String });

      export const parseUser = (input: unknown) => Schema.decodeUnknownEffect(User)(input);
    `,
    (output) => {
      assert.match(output, /Hoist Schema\.decodeUnknownEffect/);
    },
  );

  rule.invalid(
    "reports inline schema literals as high confidence findings",
    `
      import { Schema } from "effect";

      export const parseUser = (input: unknown) =>
        Schema.decodeUnknownEffect(Schema.Struct({ name: Schema.String }))(input);
    `,
    (output) => {
      assert.match(output, /inline schema literal and the compiled function/);
    },
  );
});
