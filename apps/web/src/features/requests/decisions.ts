import { toast } from 'sonner'
import { ApiError } from '@/lib/api-client.ts'
import { requestsApi, type PortalRequest } from './api.ts'

/**
 * The actions a request can take, with the toasts that say what happened. One
 * place, so the detail page and the approvals list word things identically.
 */
export async function decide(
  action: 'approve' | 'retry' | 'cancel',
  request: PortalRequest,
): Promise<boolean> {
  const messages = {
    approve:
      request.kind === 'grant_access' ? 'Approved — granting access in Azure DevOps' : 'Approved — creating it in Azure DevOps',
    retry: 'Retrying in Azure DevOps',
    cancel: 'Request withdrawn',
  }
  try {
    await requestsApi[action](request.id)
    toast.success(messages[action])
    return true
  } catch (err) {
    toast.error(err instanceof ApiError ? err.message : 'That did not go through. Try again.')
    return false
  }
}

export async function rejectRequest(request: PortalRequest, note: string): Promise<void> {
  try {
    await requestsApi.reject(request.id, note)
    toast.success('Request rejected')
  } catch (err) {
    toast.error(err instanceof ApiError ? err.message : 'That did not go through. Try again.')
    throw err
  }
}
