import "server-only";
import { z } from "zod";
import { defineTool, type AgentTool } from "./defineTool";
import { getSupabase } from "../supabase";
import { CURRENT_USER_ID } from "../currentUser";
import { todayInIndia } from "../dates";

function dateToUtcDay(value: string): Date {
  const [year, month, day] = value.split("-").map(Number);
  const date = new Date(0);
  date.setUTCHours(0, 0, 0, 0);
  date.setUTCFullYear(year, month - 1, day);
  return date;
}

function isRealIsoDate(value: string): boolean {
  const [year, month, day] = value.split("-").map(Number);
  if (year < 1) return false;
  const date = dateToUtcDay(value);
  return (
    date.getUTCFullYear() === year &&
    date.getUTCMonth() === month - 1 &&
    date.getUTCDate() === day
  );
}

const getEmployee = defineTool({
  name: "getEmployee",
  description: "Use this when the user asks about their employee profile.",
  schema: z.object({}),
  run: async () => {
    const { data, error } = await getSupabase()
      .from("employees")
      .select("id, name, email, grade, department, manager_name, base_city")
      .eq("id", CURRENT_USER_ID)
      .maybeSingle();
    if (error) throw new Error(error.message);
    if (!data) throw new Error(`No employee found with id ${CURRENT_USER_ID}`);
    return data;
  },
});

const listClaims = defineTool({
  name: "listClaims",
  description:
    "Use this when the user wants to see their expense claims. Can filter by status. Returns at most 20 claims, newest first.",
  schema: z.object({
    status: z
      .enum(["submitted", "flagged", "approved", "rejected", "paid"])
      .optional()
      .describe("Which claim status to return. Omit to include all statuses."),
  }),
  run: async ({ status }) => {
    let query = getSupabase()
      .from("claims")
      .select(
        "id, category, amount, expense_date, description, has_receipt, status, policy_check, created_at"
      )
      .eq("employee_id", CURRENT_USER_ID)
      .order("created_at", { ascending: false })
      .limit(20);
    if (status) query = query.eq("status", status);
    const { data, error } = await query;
    if (error) throw new Error(error.message);
    return { count: data.length, claims: data };
  },
});

const getPolicyRules = defineTool({
  name: "getPolicyRules",
  description: "Use this when the user asks about expense policies for their employee grade.",
  schema: z.object({}),
  run: async () => {
    const { data: employee, error: employeeError } = await getSupabase()
      .from("employees")
      .select("grade")
      .eq("id", CURRENT_USER_ID)
      .maybeSingle();
    if (employeeError) throw new Error(employeeError.message);
    if (!employee) throw new Error(`No employee found with id ${CURRENT_USER_ID}`);

    const { data: policyRules, error: policyRulesError } = await getSupabase()
      .from("policy_rules")
      .select("category, grade, max_amount, receipt_required_above, notes")
      .eq("grade", employee.grade)
      .order("category", { ascending: true });
    if (policyRulesError) throw new Error(policyRulesError.message);
    return { grade: employee.grade, policyRules };
  },
});

const submitClaim = defineTool({
  name: "submitClaim",
  description: "Use this when the user wants to submit an expense claim.",
  writes: true,
  schema: z.object({
    category: z.enum([
      "local_travel",
      "outstation_travel",
      "hotel_metro",
      "hotel_non_metro",
      "meals",
      "client_entertainment",
      "internet",
      "mobile",
      "training",
    ]),
    amount: z.number().positive().describe("Claim amount in rupees"),
    expense_date: z
      .string()
      .regex(/^\d{4}-\d{2}-\d{2}$/, "Use YYYY-MM-DD format"),
    description: z.string().trim().min(1).describe("Description of the expense"),
    has_receipt: z.boolean().describe("Whether a receipt is available"),
  }),
  run: async ({ category, amount, expense_date, description, has_receipt }) => {
    if (!isRealIsoDate(expense_date)) {
      throw new Error("Expense date must be a real date in YYYY-MM-DD format");
    }
    const expenseDay = dateToUtcDay(expense_date).getTime();
    const today = dateToUtcDay(todayInIndia()).getTime();
    const dayInMilliseconds = 24 * 60 * 60 * 1000;
    if (expenseDay > today) throw new Error("Expense date cannot be in the future");
    if (today - expenseDay > 60 * dayInMilliseconds) {
      throw new Error("Expense date cannot be more than 60 days ago");
    }

    const { data: employee, error: employeeError } = await getSupabase()
      .from("employees")
      .select("grade")
      .eq("id", CURRENT_USER_ID)
      .maybeSingle();
    if (employeeError) throw new Error(employeeError.message);
    if (!employee) throw new Error(`No employee found with id ${CURRENT_USER_ID}`);

    const { data: policy, error: policyError } = await getSupabase()
      .from("policy_rules")
      .select("max_amount, receipt_required_above")
      .eq("grade", employee.grade)
      .eq("category", category)
      .maybeSingle();
    if (policyError) throw new Error(policyError.message);
    if (!policy) {
      throw new Error(`No policy found for category ${category} and grade ${employee.grade}`);
    }

    const policyIssues: string[] = [];
    if (amount > policy.max_amount) {
      policyIssues.push(
        `Amount ${amount} exceeds the maximum allowed amount of ${policy.max_amount}.`
      );
    }
    if (amount > policy.receipt_required_above && !has_receipt) {
      policyIssues.push(
        `A receipt is required for amounts above ${policy.receipt_required_above}, but none was provided.`
      );
    }
    const status = policyIssues.length > 0 ? "flagged" : "submitted";
    const policy_check = policyIssues.length > 0 ? policyIssues.join(" ") : "Within policy";

    const { data, error } = await getSupabase()
      .from("claims")
      .insert({
        employee_id: CURRENT_USER_ID,
        category,
        amount,
        expense_date,
        description,
        has_receipt,
        status,
        policy_check,
      })
      .select(
        "id, employee_id, category, amount, expense_date, description, has_receipt, status, policy_check, created_at"
      )
      .single();
    if (error) throw new Error(error.message);
    return data;
  },
});

export const tools: AgentTool[] = [getEmployee, listClaims, getPolicyRules, submitClaim];
