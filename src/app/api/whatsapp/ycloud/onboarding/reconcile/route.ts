import { handleYCloudOnboarding } from '@/lib/whatsapp/ycloud-onboarding-route';

export const runtime = 'nodejs';

export async function POST(request: Request) {
  return handleYCloudOnboarding('reconcile', request);
}
