import type { StatusCode } from "hono/utils/http-status";

// Shared endpoint-shape helpers for the route schema files under ./routes.
// hono 4.13's `Endpoint` type is not generic, so each $method is declared as
// an Endpoint-shaped object literal: { input, output, outputFormat, status }.

export type JsonGet<Output> = {
  // `{}` (not `Record<string, never>`) so hono's client treats the endpoint as
  // empty-input and allows `$get()` with no argument.
  input: {};
  output: Output;
  outputFormat: "json";
  status: 200;
};

export type JsonPost<Input, Output, Status extends StatusCode> = {
  input: { json: Input };
  output: Output;
  outputFormat: "json";
  status: Status;
};

export type ParamGet<Param, Output> = {
  input: { param: Param };
  output: Output;
  outputFormat: "json";
  status: 200;
};

export type ParamPost<Param, Output> = {
  input: { param: Param };
  output: Output;
  outputFormat: "json";
  status: 200;
};
