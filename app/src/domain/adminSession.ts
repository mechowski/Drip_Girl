export const adminPasswordRequired = false
export const adminSessionKey = adminPasswordRequired ? 'drip-girl-admin' : 'drip-girl-admin-test'

export function hasAdminSession() {
  return typeof sessionStorage !== 'undefined' && sessionStorage.getItem(adminSessionKey) === 'yes'
}
