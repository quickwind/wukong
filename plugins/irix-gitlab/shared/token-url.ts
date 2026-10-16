/** GitLab prefills the name, description and scopes of the new-token form from the query string. */
export function tokenPageUrl(baseUrl: string): string {
  const base = baseUrl.replace(/\/+$/u, "");
  return `${base}/-/user_settings/personal_access_tokens?name=Irix&description=Irix+GitLab+access&scopes=api,read_repository,write_repository`;
}
