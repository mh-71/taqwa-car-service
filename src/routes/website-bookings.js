/**
 * Proxy route to fetch bookings from website API
 * Avoids CORS issues by relaying the request server-side
 */
export async function getWebsiteBookings(request) {
  try {
    const response = await fetch('https://taqwa.blinto.workers.dev/api/bookings/list');
    if (!response.ok) {
      return { ok: false, data: null };
    }
    const data = await response.json();
    return { ok: true, data };
  } catch (error) {
    console.error('Error proxying website bookings:', error);
    return { ok: false, data: null, error: error.message };
  }
}
