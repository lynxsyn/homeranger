/**
 * SignInPage unit tests — the unauthenticated gate. useAuth is mocked at the
 * module boundary so no Supabase client is needed; the spies record the
 * email/password passed to signIn/signUp and drive the error + confirmation
 * states.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";

const { signInMock, signUpMock, signOutMock } = vi.hoisted(() => ({
  signInMock: vi.fn(),
  signUpMock: vi.fn(),
  signOutMock: vi.fn(),
}));

vi.mock("../lib/auth", () => ({
  useAuth: () => ({
    status: "anonymous",
    user: null,
    signIn: signInMock,
    signUp: signUpMock,
    signOut: signOutMock,
  }),
}));

import { SignInPage } from "./SignInPage";

afterEach(() => {
  signInMock.mockReset();
  signUpMock.mockReset();
});

function fillCredentials(email = "person@homeranger.test", password = "hunter2!") {
  fireEvent.change(screen.getByTestId("auth-email"), { target: { value: email } });
  fireEvent.change(screen.getByTestId("auth-password"), {
    target: { value: password },
  });
}

describe("SignInPage", () => {
  it("signs in with the entered email + password", async () => {
    signInMock.mockResolvedValue({ error: null });
    render(<SignInPage />);
    fillCredentials();
    fireEvent.click(screen.getByTestId("auth-submit"));
    await waitFor(() =>
      expect(signInMock).toHaveBeenCalledWith("person@homeranger.test", "hunter2!"),
    );
  });

  it("surfaces a sign-in error", async () => {
    signInMock.mockResolvedValue({ error: "Invalid login credentials" });
    render(<SignInPage />);
    fillCredentials();
    fireEvent.click(screen.getByTestId("auth-submit"));
    expect(await screen.findByTestId("auth-error")).toHaveTextContent(
      "Invalid login credentials",
    );
  });

  it("toggles to sign-up and creates an account", async () => {
    signUpMock.mockResolvedValue({ error: null, needsConfirmation: false });
    render(<SignInPage />);
    fireEvent.click(screen.getByTestId("auth-toggle"));
    expect(screen.getByTestId("auth-submit")).toHaveTextContent("Create account");
    fillCredentials("new@homeranger.test", "s3cret-pw");
    fireEvent.click(screen.getByTestId("auth-submit"));
    await waitFor(() =>
      expect(signUpMock).toHaveBeenCalledWith("new@homeranger.test", "s3cret-pw"),
    );
  });

  it("shows a confirmation note when sign-up needs email verification", async () => {
    signUpMock.mockResolvedValue({ error: null, needsConfirmation: true });
    render(<SignInPage />);
    fireEvent.click(screen.getByTestId("auth-toggle"));
    fillCredentials();
    fireEvent.click(screen.getByTestId("auth-submit"));
    expect(await screen.findByTestId("auth-confirm")).toBeInTheDocument();
  });

  it("guards against a double-submit while a sign-in is in flight", () => {
    // A never-resolving signIn keeps the form busy; a second click must not
    // fire a second call (busy guard + disabled button).
    signInMock.mockReturnValue(new Promise(() => {}));
    render(<SignInPage />);
    fillCredentials();
    fireEvent.click(screen.getByTestId("auth-submit"));
    fireEvent.click(screen.getByTestId("auth-submit"));
    expect(signInMock).toHaveBeenCalledTimes(1);
    const submit = screen.getByTestId("auth-submit");
    expect(submit).toBeDisabled();
    expect(submit).toHaveTextContent(/One moment/i);
  });

  it("clears a surfaced error when toggling between sign-in and sign-up", async () => {
    signInMock.mockResolvedValue({ error: "Invalid login credentials" });
    render(<SignInPage />);
    fillCredentials();
    fireEvent.click(screen.getByTestId("auth-submit"));
    await screen.findByTestId("auth-error");
    fireEvent.click(screen.getByTestId("auth-toggle"));
    expect(screen.queryByTestId("auth-error")).not.toBeInTheDocument();
  });
});
