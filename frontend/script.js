/* ==========================================================================
   ReSourceX — Frontend JavaScript Controller
   ==========================================================================
   Architecture:
   1. CORE STORAGE & DATA UTILITIES
   2. AUTHENTICATION & PASSWORD RESET (index.html)
   3. DONOR CONTROLLER (donor_dashboard.html & add_resource.html)
   4. RECIPIENT CONTROLLER (recipient_dashboard.html)
   5. RESOURCE DETAILS & REQUEST CONFIRMATION (resource_details.html & request_confirmation.html)
   6. ADMIN CONTROLLER (admin_dashboard.html)
   7. GLOBAL INITIALIZATION
   ========================================================================== */

/* ==========================================================================
   1. CORE STORAGE & DATA UTILITIES
   ========================================================================== */

/**
 * Escapes unsafe characters for safe DOM insertion
 */
function escapeHtml(str) {
    if (str === null || str === undefined) return "";
    return String(str)
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;")
        .replace(/'/g, "&#039;");
}

/* ==========================================================================
   BACKEND API CLIENT (authentication migration — resources remain local for now)
   ========================================================================== */
const API_BASE_URL = window.RESOURCEX_API_URL || "https://resourcex-hjz9.onrender.com/api";
const AUTH_TOKEN_KEY = "resourceXAuthToken";
const CURRENT_USER_KEY = "resourceXCurrentUser";
let recipientMatchCache = new Map();
let adminResourceCache = new Map();
let donorResourceCache = null;

function getAuthToken() {
    return localStorage.getItem(AUTH_TOKEN_KEY);
}

function saveAuthSession(payload) {
    if (payload?.token) localStorage.setItem(AUTH_TOKEN_KEY, payload.token);
    if (payload?.user) localStorage.setItem(CURRENT_USER_KEY, JSON.stringify(payload.user));
}

function getCurrentUser() {
    try { return JSON.parse(localStorage.getItem(CURRENT_USER_KEY) || "null"); }
    catch (error) { return null; }
}

function clearAuthSession() {
    localStorage.removeItem(AUTH_TOKEN_KEY);
    localStorage.removeItem(CURRENT_USER_KEY);
}

async function apiRequest(path, options = {}) {
    const headers = Object.assign({}, options.headers || {});
    const token = getAuthToken();
    if (token) headers.Authorization = `Bearer ${token}`;
    const requestOptions = Object.assign({}, options, { headers });
    if (options.body && typeof options.body !== "string") {
        headers["Content-Type"] = "application/json";
        requestOptions.body = JSON.stringify(options.body);
    }
    const response = await fetch(API_BASE_URL + path, requestOptions);
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(data.error || `Request failed (${response.status})`);
    return data;
}

window.resourceXApi = { apiRequest, getAuthToken, getCurrentUser, clearAuthSession };
/**
 * Retrieves resources from localStorage without auto-seeding fake data.
 */
function getResources() {
    try {
        const data = localStorage.getItem("resourceXResources");
        return data ? JSON.parse(data) : [];
    } catch (e) {
        console.error("Error reading resources from localStorage", e);
        return [];
    }
}

/**
 * Persists resources to localStorage.
 */
function saveResources(resources) {
    try {
        localStorage.setItem("resourceXResources", JSON.stringify(resources || []));
    } catch (e) {
        console.error("Error saving resources to localStorage", e);
    }
}

/**
 * Retrieves registered accounts from localStorage.
 */
function getAccounts() {
    try {
        const data = localStorage.getItem("resourceXAccounts");
        return data ? JSON.parse(data) : [];
    } catch (e) {
        console.error("Error reading accounts from localStorage", e);
        return [];
    }
}

/**
 * Persists registered accounts to localStorage.
 */
function saveAccounts(accounts) {
    try {
        localStorage.setItem("resourceXAccounts", JSON.stringify(accounts || []));
    } catch (e) {
        console.error("Error saving accounts to localStorage", e);
    }
}


/* ==========================================================================
   2. AUTHENTICATION & PASSWORD RESET (index.html)
   ========================================================================== */

function initAuth() {
    const signInTab = document.getElementById("signInTab");
    const registerTab = document.getElementById("registerTab");
    const signInContainer = document.getElementById("signInFormContainer");
    const registerContainer = document.getElementById("registerFormContainer");
    const forgotPasswordContainer = document.getElementById("forgotPasswordContainer");
    const forgotPasswordLink = document.getElementById("forgotPasswordLink");
    const backToSignInLink = document.getElementById("backToSignInLink");
    const registerRole = document.getElementById("registerRole");
    const adminCodeGroup = document.getElementById("adminCodeGroup");
    const adminCodeInput = document.getElementById("adminCode");

    registerRole?.addEventListener("change", function () {
        const isAdmin = this.value.toLowerCase() === "admin";
        adminCodeGroup?.classList.toggle("hidden", !isAdmin);
        if (adminCodeInput) {
            adminCodeInput.required = isAdmin;
            if (!isAdmin) adminCodeInput.value = "";
        }
    });

    // Tab Switching: Sign In
    signInTab?.addEventListener("click", function () {
        signInTab.classList.add("active");
        registerTab?.classList.remove("active");

        signInContainer?.classList.remove("hidden");
        registerContainer?.classList.add("hidden");
        forgotPasswordContainer?.classList.add("hidden");
    });

    // Tab Switching: Register
    registerTab?.addEventListener("click", function () {
        registerTab.classList.add("active");
        signInTab?.classList.remove("active");

        registerContainer?.classList.remove("hidden");
        signInContainer?.classList.add("hidden");
        forgotPasswordContainer?.classList.add("hidden");
    });

    // Toggle to Forgot Password view
    forgotPasswordLink?.addEventListener("click", function (e) {
        e.preventDefault();
        signInContainer?.classList.add("hidden");
        registerContainer?.classList.add("hidden");
        forgotPasswordContainer?.classList.remove("hidden");

        signInTab?.classList.remove("active");
        registerTab?.classList.remove("active");
    });

    // Back to Sign In from Forgot Password
    backToSignInLink?.addEventListener("click", function (e) {
        e.preventDefault();
        forgotPasswordContainer?.classList.add("hidden");
        signInContainer?.classList.remove("hidden");
        signInTab?.classList.add("active");
    });

    // Login Form Submit — now backed by the Express API
    document.getElementById("loginForm")?.addEventListener("submit", async function (e) {
        e.preventDefault();

        const email = document.getElementById("loginEmail")?.value.trim().toLowerCase();
        const password = document.getElementById("loginPassword")?.value;
        const selectedRole = document.getElementById("roleSelect")?.value;

        if (!email || !password || !selectedRole) {
            alert("Please enter your email, password, and role.");
            return;
        }

        try {
            const data = await apiRequest("/auth/login", {
                method: "POST",
                body: { email, password, role: selectedRole }
            });
            saveAuthSession(data);
            const destinationRole = (data.user?.role || selectedRole).toLowerCase();
            alert(`Welcome back, ${data.user?.firstName || "there"}!`);
            if (destinationRole === "donor") window.location.href = "donor_dashboard.html";
            else if (destinationRole === "recipient") window.location.href = "recipient_dashboard.html";
            else if (destinationRole === "admin") window.location.href = "admin_dashboard.html";
        } catch (error) {
            console.error("Login failed", error);
            alert("❌ " + error.message);
        }
    });

    // Registration Form Submit — now backed by the Express API
    document.getElementById("registerForm")?.addEventListener("submit", async function (e) {
        e.preventDefault();

        const firstName = document.getElementById("registerFirstName")?.value.trim();
        const lastName = document.getElementById("registerLastName")?.value.trim();
        const email = document.getElementById("registerEmail")?.value.trim().toLowerCase();
        const password = document.getElementById("registerPassword")?.value;
        const selectedRole = document.getElementById("registerRole")?.value;
        const adminCode = document.getElementById("adminCode")?.value;

        if (!firstName || !lastName || !email || !password || !selectedRole) {
            alert("Please fill in all required fields.");
            return;
        }

        try {
            await apiRequest("/auth/register", {
                method: "POST",
                body: { firstName, lastName, email, password, role: selectedRole, adminCode }
            });
            alert("🎉 Account created successfully! Please sign in.");
            document.getElementById("registerForm").reset();
            registerContainer?.classList.add("hidden");
            signInContainer?.classList.remove("hidden");
            registerTab?.classList.remove("active");
            signInTab?.classList.add("active");
        } catch (error) {
            console.error("Registration failed", error);
            alert("❌ " + error.message);
        }
    });
    // Forgot Password Form Submit
    document.getElementById("forgotPasswordForm")?.addEventListener("submit", function (e) {
        e.preventDefault();

        const email = document.getElementById("resetEmail")?.value.trim().toLowerCase();
        const newPassword = document.getElementById("resetNewPassword")?.value;
        const confirmPassword = document.getElementById("resetConfirmPassword")?.value;

        if (newPassword !== confirmPassword) {
            alert("❌ Passwords do not match. Please re-enter your new password.");
            return;
        }

        const accounts = getAccounts();
        const userIndex = accounts.findIndex(u => u.email.toLowerCase() === email);

        if (userIndex === -1) {
            alert("❌ No registered account found with this email address. Please register a new account.");
            return;
        }

        accounts[userIndex].password = newPassword;
        saveAccounts(accounts);

        alert("✅ Password updated successfully! Please sign in with your new password.");
        document.getElementById("forgotPasswordForm").reset();

        forgotPasswordContainer?.classList.add("hidden");
        signInContainer?.classList.remove("hidden");
        signInTab?.classList.add("active");
    });
}


/* ==========================================================================
   3. DONOR CONTROLLER (donor_dashboard.html & add_resource.html)
   ========================================================================== */

let currentDonorFilter = "all";

/**
 * Opens details modal for a resource (used in donor and admin views).
 */
function openDonorModalById(resourceId) {
    const resources = getResources();
    const resource = adminResourceCache.get(String(resourceId)) ||
        (Array.isArray(donorResourceCache) ? donorResourceCache.find(r => String(r.id) === String(resourceId)) : null) ||
        resources.find(r => String(r.id) === String(resourceId));

    if (!resource) {
        alert("Resource details not found.");
        return;
    }

    const modal = document.getElementById("resourceModal");
    if (!modal) return;

    const modalName = document.getElementById("modalResourceName");
    const modalType = document.getElementById("modalResourceType");
    const modalQuantity = document.getElementById("modalResourceQuantity");
    const modalStatus = document.getElementById("modalResourceStatus");
    const modalLocation = document.getElementById("modalResourceLocation");
    const modalAvailability = document.getElementById("modalResourceAvailability");
    const modalDescription = document.getElementById("modalResourceDescription");
    const modalSpecifications = document.getElementById("modalResourceSpecifications");

    if (modalName) modalName.textContent = resource.name || "Unnamed Resource";
    if (modalType) modalType.textContent = resource.category || "Other";
    if (modalQuantity) modalQuantity.textContent = resource.quantity || "-";
    if (modalStatus) modalStatus.textContent = resource.status || "Available";
    if (modalLocation) modalLocation.textContent = resource.location || "Not specified";
    if (modalAvailability) modalAvailability.textContent = resource.availability || "Not specified";
    if (modalDescription) modalDescription.textContent = resource.description || "No description provided.";
    if (modalSpecifications) modalSpecifications.textContent = resource.specifications || "No specifications provided.";

    modal.classList.add("show");
}

function closeResourceModal() {
    const modal = document.getElementById("resourceModal");
    if (modal) modal.classList.remove("show");
}

// Close modal on backdrop click
document.getElementById("resourceModal")?.addEventListener("click", function (e) {
    if (e.target === this) {
        closeResourceModal();
    }
});

/**
 * Filter button click handler for Donor's My Resources table
 */
function filterDonorResources(filterType) {
    currentDonorFilter = (filterType || "all").toLowerCase();

    const pillsContainer = document.getElementById("myResourcesFilterPills");
    if (pillsContainer) {
        const buttons = pillsContainer.querySelectorAll(".filter-pill");
        buttons.forEach(btn => {
            const btnText = btn.textContent.toLowerCase().trim();
            if (btnText === currentDonorFilter) {
                btn.classList.add("active");
            } else {
                btn.classList.remove("active");
            }
        });
    }

    renderDonorMyResources();
}

/**
 * Renders the My Resources table in donor dashboard
 */
function renderDonorMyResources() {
    const tableBody = document.getElementById("donorResourceTableBody");
    if (!tableBody) return;

    const resources = Array.isArray(donorResourceCache) ? donorResourceCache : getResources();
    const filtered = resources.filter(res => {
        if (currentDonorFilter === "all") return true;
        return (res.status || "available").toLowerCase() === currentDonorFilter;
    });

    tableBody.innerHTML = "";

    if (filtered.length === 0) {
        tableBody.innerHTML = `
            <tr>
                <td colspan="6" class="empty-table-cell">
                    No resources found matching filter "<strong>${escapeHtml(currentDonorFilter)}</strong>".
                </td>
            </tr>
        `;
        return;
    }

    filtered.forEach(res => {
        const tr = document.createElement("tr");
        const statusClass = (res.status || "Available").toLowerCase();

        tr.innerHTML = `
            <td><strong>${escapeHtml(res.name)}</strong></td>
            <td>${escapeHtml(res.category || "Other")}</td>
            <td>${escapeHtml(String(res.quantity))}</td>
            <td>${escapeHtml(res.location || "Not specified")}</td>
            <td>
                <span class="status ${statusClass}">
                    ${escapeHtml(res.status || "Available")}
                </span>
            </td>
            <td>
                <div class="admin-actions">
                    <button
                        type="button"
                        class="table-btn"
                        onclick="openDonorModalById('${res.id}')">
                        View
                    </button>
                    <button
                        type="button"
                        class="admin-btn-delete"
                        onclick="donorDeleteResource('${res.id}')">
                        Delete
                    </button>
                </div>
            </td>
        `;
        tableBody.appendChild(tr);
    });
}

/**
 * Renders the Incoming Requests table in donor dashboard
 */
async function renderDonorRequests() {
    const requestsTableBody = document.getElementById("donorRequestsTableBody");
    const badgeEl = document.getElementById("donorPendingRequestsBadge");
    if (!requestsTableBody && !badgeEl) return;

    if (getAuthToken() && getCurrentUser()?.role === "DONOR") {
        try {
            const data = await apiRequest("/requests");
            const requests = data.requests || [];
            const pendingRequests = requests.filter(request => request.status === "PENDING");
            if (badgeEl) badgeEl.textContent = `${pendingRequests.length} Pending`;
            if (!requestsTableBody) return;
            requestsTableBody.innerHTML = "";
            if (!requests.length) {
                requestsTableBody.innerHTML = `<tr><td colspan="6" class="empty-table-cell">No requests have been submitted yet.</td></tr>`;
                return;
            }
            requests.forEach(request => {
                const resource = request.resource || {};
                const action = request.status === "PENDING"
                    ? `<button type="button" class="btn-approve" onclick="reviewApiRequest('${request.id}', 'approve')">Approve</button><button type="button" class="btn-decline" onclick="reviewApiRequest('${request.id}', 'decline')">Decline</button>`
                    : request.status === "APPROVED"
                        ? `<button type="button" class="btn-approve" onclick="handoverApiRequest('${request.id}')">Mark handed over</button>`
                        : request.status === "HANDED_OVER"
                            ? "Awaiting recipient confirmation"
                            : request.status === "COMPLETED" ? "Completed" : "No action";
                const tr = document.createElement("tr");
                tr.innerHTML = `<td><strong>${escapeHtml(resource.name || "Resource")}</strong></td><td>${escapeHtml(resource.category || "Other")}</td><td>${escapeHtml(String(resource.quantity || "-"))}</td><td>${escapeHtml(resource.location || "Not specified")}</td><td><span class="status ${(request.status || "").toLowerCase()}">${escapeHtml(request.status)}</span></td><td><div class="admin-actions">${action}</div></td>`;
                requestsTableBody.appendChild(tr);
            });
            return;
        } catch (error) {
            console.error("Unable to load donor requests", error);
        }
    }

    const resources = getResources();
    const requestedItems = resources.filter(r => (r.status || "").toLowerCase() === "requested");

    if (badgeEl) {
        badgeEl.textContent = `${requestedItems.length} Pending`;
    }

    if (!requestsTableBody) return;

    requestsTableBody.innerHTML = "";

    if (requestedItems.length === 0) {
        requestsTableBody.innerHTML = `
            <tr>
                <td colspan="6" class="empty-table-cell">
                    🎉 No pending requests. All resources are currently available or allocated.
                </td>
            </tr>
        `;
        return;
    }

    requestedItems.forEach(res => {
        const tr = document.createElement("tr");

        tr.innerHTML = `
            <td><strong>${escapeHtml(res.name)}</strong></td>
            <td>${escapeHtml(res.category || "Other")}</td>
            <td>${escapeHtml(String(res.quantity))}</td>
            <td>${escapeHtml(res.location || "Not specified")}</td>
            <td>
                <span class="status requested">Requested</span>
            </td>
            <td>
                <div class="admin-actions">
                    <button
                        type="button"
                        class="btn-approve"
                        onclick="donorApproveRequest('${res.id}')">
                        ✓ Approve & Allocate
                    </button>
                    <button
                        type="button"
                        class="btn-decline"
                        onclick="donorDeclineRequest('${res.id}')">
                        ✕ Decline
                    </button>
                </div>
            </td>
        `;
        requestsTableBody.appendChild(tr);
    });
}

async function reviewApiRequest(requestId, action) {
    try {
        await apiRequest(`/requests/${requestId}/${action}`, { method: "PUT" });
        alert(action === "approve" ? "Request approved and allocated." : "Request declined.");
        await renderDonorRequests();
    } catch (error) {
        alert("❌ " + error.message);
    }
}

async function handoverApiRequest(requestId) {
    try {
        await apiRequest(`/requests/${requestId}/handover`, { method: "PUT" });
        alert("Resource marked as handed over.");
        await renderDonorRequests();
    } catch (error) {
        alert("❌ " + error.message);
    }
}

async function initLiveDonorDashboard() {
    const tableBody = document.getElementById("donorResourceTableBody");
    const activityList = document.getElementById("donorActivityList");
    if (tableBody) tableBody.innerHTML = `<tr><td colspan="6" class="loading-cell">Loading your resources...</td></tr>`;
    if (activityList) activityList.innerHTML = `<div class="activity-item"><div><p>Loading activity...</p></div></div>`;
    try {
        const data = await apiRequest("/resources");
        donorResourceCache = data.resources || [];
        const resources = donorResourceCache;
        const counts = {
            total: resources.length,
            available: resources.filter(resource => resource.status === "AVAILABLE").length,
            requested: resources.filter(resource => resource.status === "REQUESTED").length,
            allocated: resources.filter(resource => ["ALLOCATED", "HANDED_OVER", "COMPLETED"].includes(resource.status)).length
        };
        document.getElementById("donorTotalCount").textContent = counts.total;
        document.getElementById("donorAvailableCount").textContent = counts.available;
        document.getElementById("donorRequestedCount").textContent = counts.requested;
        document.getElementById("donorAllocatedCount").textContent = counts.allocated;
        renderDonorMyResources();
        renderDonorActivity();
        await renderDonorRequests();
    } catch (error) {
        console.error("Unable to load donor resources", error);
        if (tableBody) tableBody.innerHTML = `<tr><td colspan="6" class="empty-table-cell">Unable to load your resources. Please refresh and try again.</td></tr>`;
        if (activityList) activityList.innerHTML = `<div class="activity-item"><div><p>Unable to load activity. Please refresh and try again.</p></div></div>`;
    }
}

/**
 * Donor approves request: status becomes "Allocated"
 */
function donorApproveRequest(resourceId) {
    const resources = getResources();
    const index = resources.findIndex(r => String(r.id) === String(resourceId));

    if (index === -1) {
        alert("Resource not found.");
        return;
    }

    resources[index].status = "Allocated";
    saveResources(resources);

    alert("🤝 Request approved! The resource has been marked as Allocated.");
    initDonorDashboard();
}

/**
 * Donor declines request: status returns to "Available"
 */
function donorDeclineRequest(resourceId) {
    const resources = getResources();
    const index = resources.findIndex(r => String(r.id) === String(resourceId));

    if (index === -1) {
        alert("Resource not found.");
        return;
    }

    resources[index].status = "Available";
    saveResources(resources);

    alert("🔄 Request declined. The resource is now Available again for community requests.");
    initDonorDashboard();
}

/**
 * Donor deletes resource
 */
function donorDeleteResource(resourceId) {
    if (!confirm("Are you sure you want to delete this resource?")) return;

    if (getAuthToken() && Number.isSafeInteger(Number(resourceId))) {
        apiRequest(`/resources/${resourceId}`, { method: "DELETE" })
            .then(() => {
                alert("🗑️ Resource deleted.");
                initLiveDonorDashboard();
            })
            .catch(error => alert("❌ " + error.message));
        return;
    }

    let resources = getResources();
    resources = resources.filter(r => String(r.id) !== String(resourceId));
    saveResources(resources);

    alert("🗑️ Resource deleted.");
    initDonorDashboard();
}

/**
 * Renders activity log on donor dashboard
 */
function renderDonorActivity() {
    const activityList = document.getElementById("donorActivityList");
    if (!activityList) return;

    const resources = Array.isArray(donorResourceCache) ? donorResourceCache : getResources();
    activityList.innerHTML = "";

    if (resources.length === 0) {
        activityList.innerHTML = `
            <div class="activity-item">
                <div>
                    <p>No activity recorded yet. Add your first surplus resource to get started.</p>
                </div>
            </div>
        `;
        return;
    }

    resources.forEach(item => {
        let icon = "➕";
        let text = `${escapeHtml(item.name)} added to your surplus resources.`;
        const statusLower = (item.status || "").toLowerCase();

        if (statusLower === "requested") {
            icon = "🔔";
            text = `A recipient has requested ${escapeHtml(item.name)}. Awaiting your approval.`;
        } else if (statusLower === "allocated") {
            icon = "🤝";
            text = `${escapeHtml(item.name)} was approved and successfully allocated.`;
        }

        const actDiv = document.createElement("div");
        actDiv.className = "activity-item";
        actDiv.innerHTML = `
            <span class="activity-icon">${icon}</span>
            <div>
                <strong>${escapeHtml(item.name)} (${escapeHtml(item.status || "Available")})</strong>
                <p>${text}</p>
            </div>
            <span class="activity-time">${escapeHtml(item.createdAt || item.availability || "Recent")}</span>
        `;
        activityList.appendChild(actDiv);
    });
}

/**
 * Initializes donor dashboard stats, tables, and navigation listeners
 */
function initDonorDashboard() {
    const isDonorDashboard = document.getElementById("donorResourceTableBody") || document.getElementById("donorRequestsTableBody");
    if (!isDonorDashboard) return;

    if (getAuthToken() && getCurrentUser()?.role === "DONOR") {
        initLiveDonorDashboard();
        return;
    }

    const resources = getResources();

    // Stats calculations
    const totalCount = resources.length;
    const availableCount = resources.filter(r => (r.status || "available").toLowerCase() === "available").length;
    const requestedCount = resources.filter(r => (r.status || "").toLowerCase() === "requested").length;
    const allocatedCount = resources.filter(r => (r.status || "").toLowerCase() === "allocated").length;

    const totalEl = document.getElementById("donorTotalCount");
    const availableEl = document.getElementById("donorAvailableCount");
    const requestedEl = document.getElementById("donorRequestedCount");
    const allocatedEl = document.getElementById("donorAllocatedCount");

    if (totalEl) totalEl.textContent = totalCount;
    if (availableEl) availableEl.textContent = availableCount;
    if (requestedEl) requestedEl.textContent = requestedCount;
    if (allocatedEl) allocatedEl.textContent = allocatedCount;

    // Render Subsections
    renderDonorMyResources();
    renderDonorRequests();
    renderDonorActivity();

    // Sidebar active state navigation sync
    const navItems = document.querySelectorAll(".sidebar-nav .nav-item");
    navItems.forEach(item => {
        item.addEventListener("click", function () {
            navItems.forEach(n => n.classList.remove("active"));
            this.classList.add("active");
        });
    });
}

/**
 * Add Resource Form Handler (add_resource.html)
 */
function initAddResource() {
    const form = document.getElementById("resourceForm");
    if (!form) return;

    form.addEventListener("submit", async function (e) {
        e.preventDefault();

        const name = document.getElementById("resourceName")?.value.trim();
        const category = document.getElementById("resourceCategory")?.value;
        const quantity = document.getElementById("resourceQuantity")?.value;
        const condition = document.getElementById("resourceCondition")?.value;
        const location = document.getElementById("resourceLocation")?.value.trim();
        const availability = document.getElementById("resourceAvailability")?.value;
        const description = document.getElementById("resourceDescription")?.value.trim();
        const specifications = document.getElementById("resourceSpecifications")?.value.trim();

        if (!name || !category || !quantity) {
            alert("Please fill in the resource name, category, and quantity.");
            return;
        }

        if (getAuthToken()) {
            const submitButton = form.querySelector("button[type=submit]");
            if (submitButton) submitButton.disabled = true;
            try {
                await apiRequest("/resources", {
                    method: "POST",
                    body: {
                        name,
                        category,
                        quantity: Number(quantity),
                        condition: condition || "Good",
                        location: location || "Not specified",
                        availability: availability || "Available now",
                        description: description || "No description provided.",
                        specifications: specifications || "Standard"
                    }
                });
                alert("🎉 Resource added successfully!");
                window.location.href = "donor_dashboard.html";
                return;
            } catch (error) {
                if (submitButton) submitButton.disabled = false;
                alert("❌ " + error.message);
                return;
            }
        }

        const newResource = {
            id: "RSX-" + Date.now(),
            name,
            category,
            quantity,
            condition: condition || "Good",
            location: location || "Not specified",
            availability: availability || "Available now",
            description: description || "No description provided.",
            specifications: specifications || "Standard",
            status: "Available",
            createdAt: "Today"
        };

        const resources = getResources();
        resources.unshift(newResource);
        saveResources(resources);

        alert("🎉 Resource added successfully!");
        window.location.href = "donor_dashboard.html";
    });
}


/* ==========================================================================
   4. RECIPIENT CONTROLLER (recipient_dashboard.html)
   ========================================================================== */

function initRecipientDashboard() {
    const resourceList = document.getElementById("resourceList");
    if (!resourceList) return;

    const searchInput = document.getElementById("resourceSearch");
    const categoryFilter = document.getElementById("categoryFilter");
    const resourceCount = document.getElementById("resourceCount");
    const emptyState = document.getElementById("emptyState");
    const locationInput = document.getElementById("recipientLocation");
    const quantityInput = document.getElementById("requiredQuantity");
    const urgencySelect = document.getElementById("recipientUrgency");
    const matchingStatus = document.getElementById("matchingStatus");
    let matchingRequestId = 0;
    let matchingDebounceTimer;

    async function renderRecipientGrid() {
        const searchTerm = (searchInput?.value || "").toLowerCase().trim();
        const selectedCategory = (categoryFilter?.value || "all").toLowerCase();
        const requestId = ++matchingRequestId;
        const query = new URLSearchParams();
        if (selectedCategory !== "all") query.set("category", selectedCategory);
        if (searchTerm) query.set("search", searchTerm);
        if (locationInput?.value.trim()) query.set("location", locationInput.value.trim());
        if (quantityInput?.value) query.set("quantity", quantityInput.value);
        if (urgencySelect?.value) query.set("urgency", urgencySelect.value);

        if (matchingStatus) {
            matchingStatus.className = "matching-status loading";
            matchingStatus.textContent = "Loading recommendations...";
        }
        if (emptyState) emptyState.style.display = "none";

        try {
            const data = await apiRequest(`/matching?${query.toString()}`);
            if (requestId !== matchingRequestId) return;
            const matches = Array.isArray(data.matches) ? data.matches : [];
            recipientMatchCache = new Map(matches.map(match => [String(match.id), match]));
            resourceList.innerHTML = "";
            if (matchingStatus) {
                matchingStatus.className = "matching-status";
                matchingStatus.textContent = matches.length ? "Ranked by match score" : "No suitable available resources matched these requirements.";
            }
            if (resourceCount) resourceCount.textContent = `${matches.length} resource${matches.length !== 1 ? "s" : ""}`;
            if (!matches.length) {
                if (emptyState) emptyState.style.display = "block";
                return;
            }

            if (emptyState) emptyState.style.display = "none";
            matches.forEach(res => {
                const card = document.createElement("div");
                card.className = "resource-card recommended-card";
                const reasons = (res.matchReasons || []).map(reason => `<li>${escapeHtml(reason)}</li>`).join("");
                card.innerHTML = `
                    <div class="resource-card-header">
                        <div class="resource-icon">📦</div>
                        <span class="resource-category">${escapeHtml(res.category || "Other")}</span>
                    </div>
                    <div class="match-score">${escapeHtml(String(res.matchScore))}% Match</div>
                    <h3>${escapeHtml(res.name)}</h3>
                    <div class="resource-details">
                        <p><strong>Quantity:</strong> ${escapeHtml(String(res.quantity))}</p>
                        <p><strong>Condition:</strong> ${escapeHtml(res.condition || "Good")}</p>
                        <p><strong>Location:</strong> ${escapeHtml(res.location || "Not specified")}</p>
                        <p><strong>Available:</strong> ${escapeHtml(res.availability || "Today")}</p>
                    </div>
                    <ul class="match-reasons">${reasons}</ul>
                    <div class="resource-card-actions">
                        <button type="button" class="view-details-btn" onclick="viewResource('${escapeHtml(res.id)}')">View Details</button>
                        <button type="button" class="request-btn" onclick="requestResource('${escapeHtml(res.id)}')">Request Resource</button>
                    </div>
                `;
                resourceList.appendChild(card);
            });
        } catch (error) {
            if (requestId !== matchingRequestId) return;
            if (matchingStatus) {
                matchingStatus.className = "matching-status error";
                matchingStatus.textContent = "Unable to refresh recommendations. Showing the previous results.";
            }
            if (emptyState) {
                emptyState.style.display = resourceList.children.length ? "none" : "block";
            }
            console.error("Matching request failed", error);
        }
    }

    function scheduleRecipientMatch() {
        clearTimeout(matchingDebounceTimer);
        matchingDebounceTimer = setTimeout(renderRecipientGrid, 300);
    }

    searchInput?.addEventListener("input", scheduleRecipientMatch);
    categoryFilter?.addEventListener("change", scheduleRecipientMatch);
    locationInput?.addEventListener("input", scheduleRecipientMatch);
    quantityInput?.addEventListener("input", scheduleRecipientMatch);
    urgencySelect?.addEventListener("change", scheduleRecipientMatch);

    renderRecipientGrid();
    renderRecipientRequests();

    // Sidebar active state navigation sync
    const navItems = document.querySelectorAll(".sidebar-nav .nav-item");
    navItems.forEach(item => {
        item.addEventListener("click", function () {
            navItems.forEach(n => n.classList.remove("active"));
            this.classList.add("active");
        });
    });
}

/**
 * Renders the My Submitted Requests section in recipient dashboard
 */
async function renderRecipientRequests() {
    const tableBody = document.getElementById("recipientRequestsTableBody");
    const countEl = document.getElementById("recipientRequestCount");
    if (!tableBody) return;

    if (getAuthToken() && getCurrentUser()?.role === "RECIPIENT") {
        try {
            const data = await apiRequest("/requests");
            const requests = data.requests || [];
            if (countEl) countEl.textContent = `${requests.length} Request${requests.length !== 1 ? "s" : ""}`;
            tableBody.innerHTML = "";
            if (!requests.length) {
                tableBody.innerHTML = `<tr><td colspan="5" class="empty-table-cell">You haven't requested any resources yet.</td></tr>`;
                return;
            }
            requests.forEach(request => {
                const resource = request.resource || {};
                const action = request.status === "HANDED_OVER"
                    ? `<button type="button" class="btn-approve" onclick="completeApiRequest('${request.id}')">Confirm received</button>`
                    : request.status === "COMPLETED" ? "Receipt confirmed" : "";
                const tr = document.createElement("tr");
                tr.innerHTML = `<td><strong>${escapeHtml(resource.name || "Resource")}</strong></td><td>${escapeHtml(resource.category || "Other")}</td><td>${escapeHtml(String(resource.quantity || "-"))}</td><td>${escapeHtml(resource.location || "Not specified")}</td><td><span class="status ${(request.status || "").toLowerCase()}">${escapeHtml(request.status)}</span> ${action}</td>`;
                tableBody.appendChild(tr);
            });
            return;
        } catch (error) {
            console.error("Unable to load recipient requests", error);
        }
    }

    const resources = getResources();
    const myRequests = resources.filter(r => {
        const s = (r.status || "").toLowerCase();
        return s === "requested" || s === "allocated";
    });

    if (countEl) {
        countEl.textContent = `${myRequests.length} Request${myRequests.length !== 1 ? "s" : ""}`;
    }

    tableBody.innerHTML = "";

    if (myRequests.length === 0) {
        tableBody.innerHTML = `
            <tr>
                <td colspan="5" class="empty-table-cell">
                    You haven't requested any resources yet. Browse the available items above and click <strong>Request Resource</strong>.
                </td>
            </tr>
        `;
        return;
    }

    myRequests.forEach(res => {
        const tr = document.createElement("tr");
        const statusLower = (res.status || "Requested").toLowerCase();
        const displayStatus = statusLower === "allocated" ? "Allocated / Approved" : "Pending Donor Approval";

        tr.innerHTML = `
            <td><strong>${escapeHtml(res.name)}</strong></td>
            <td>${escapeHtml(res.category || "Other")}</td>
            <td>${escapeHtml(String(res.quantity))}</td>
            <td>${escapeHtml(res.location || "Not specified")}</td>
            <td>
                <span class="status ${statusLower}">
                    ${escapeHtml(displayStatus)}
                </span>
            </td>
        `;
        tableBody.appendChild(tr);
    });
}

async function completeApiRequest(requestId) {
    try {
        await apiRequest(`/requests/${requestId}/complete`, { method: "PUT" });
        alert("Receipt confirmed. The request is complete.");
        await renderRecipientRequests();
    } catch (error) {
        alert("❌ " + error.message);
    }
}

/**
 * Saves selected resource and navigates to resource_details.html
 */
function viewResource(resourceId) {
    const resources = getResources();
    const resource = recipientMatchCache.get(String(resourceId)) || resources.find(r => String(r.id) === String(resourceId));

    if (!resource) {
        alert("Resource not found.");
        return;
    }

    localStorage.setItem("selectedResource", JSON.stringify(resource));
    window.location.href = "resource_details.html";
}

/**
 * Saves selected resource and navigates directly to request_confirmation.html
 */
function requestResource(resourceId) {
    const resources = getResources();
    const resource = recipientMatchCache.get(String(resourceId)) || resources.find(r => String(r.id) === String(resourceId));

    if (!resource) {
        alert("Resource not found.");
        return;
    }

    localStorage.setItem("selectedResource", JSON.stringify(resource));
    window.location.href = "request_confirmation.html";
}


/* ==========================================================================
   5. RESOURCE DETAILS & CONFIRMATION (resource_details.html & request_confirmation.html)
   ========================================================================== */

/**
 * Populates resource_details.html dynamically from selectedResource
 */
function initResourceDetails() {
    const nameEl = document.getElementById("resourceName");
    // Ensure we are on resource_details.html (it has #requestResourceBtn)
    const requestBtn = document.getElementById("requestResourceBtn");
    if (!nameEl || !requestBtn) return;

    let selectedResource = null;
    try {
        selectedResource = JSON.parse(localStorage.getItem("selectedResource") || "null");
    } catch (e) {
        selectedResource = null;
    }

    if (!selectedResource) {
        alert("No resource selected. Returning to available resources.");
        window.location.href = "recipient_dashboard.html";
        return;
    }

    nameEl.textContent = selectedResource.name || "Unnamed Resource";

    const catEl = document.getElementById("resourceCategory");
    if (catEl) catEl.textContent = selectedResource.category || "Other";

    const qtyEl = document.getElementById("resourceQuantity");
    if (qtyEl) qtyEl.textContent = selectedResource.quantity || "-";

    const condEl = document.getElementById("resourceCondition");
    if (condEl) condEl.textContent = selectedResource.condition || "Good";

    const locEl = document.getElementById("resourceLocation");
    if (locEl) locEl.textContent = selectedResource.location || "Not specified";

    const availEl = document.getElementById("resourceAvailability");
    if (availEl) availEl.textContent = selectedResource.availability || "Not specified";

    const descEl = document.getElementById("resourceDescription");
    if (descEl) descEl.textContent = selectedResource.description || "No description provided.";

    const specEl = document.getElementById("resourceSpecifications");
    if (specEl) specEl.textContent = selectedResource.specifications || "No specifications provided.";

    requestBtn.addEventListener("click", function () {
        window.location.href = "request_confirmation.html";
    });
}

/**
 * Populates request_confirmation.html and processes status update: Available -> Requested
 */
function initRequestConfirmation() {
    const confirmNameEl = document.getElementById("confirmResourceName");
    const confirmBtn = document.getElementById("confirmRequestBtn");
    if (!confirmNameEl || !confirmBtn) return;

    let selectedResource = null;
    try {
        selectedResource = JSON.parse(localStorage.getItem("selectedResource") || "null");
    } catch (e) {
        selectedResource = null;
    }

    if (!selectedResource) {
        alert("No resource selected. Returning to recipient dashboard.");
        window.location.href = "recipient_dashboard.html";
        return;
    }

    confirmNameEl.textContent = selectedResource.name || "Unnamed Resource";

    const catEl = document.getElementById("confirmCategory");
    if (catEl) catEl.textContent = selectedResource.category || "Other";

    const qtyEl = document.getElementById("confirmQuantity");
    if (qtyEl) qtyEl.textContent = selectedResource.quantity || "-";

    const locEl = document.getElementById("confirmLocation");
    if (locEl) locEl.textContent = selectedResource.location || "Not specified";

    confirmBtn.addEventListener("click", async function () {
        confirmBtn.disabled = true;
        const urgency = document.getElementById("requestUrgency")?.value || "MEDIUM";
        const purpose = document.getElementById("requestPurpose")?.value.trim() || "";

        if (getAuthToken() && Number.isSafeInteger(Number(selectedResource.id))) {
            try {
                await apiRequest("/requests", {
                    method: "POST",
                    body: { resourceId: Number(selectedResource.id), urgency, purpose }
                });
                localStorage.removeItem("selectedResource");
                alert("🎉 Resource request submitted successfully! The donor has received your request.");
                window.location.href = "recipient_dashboard.html";
                return;
            } catch (error) {
                confirmBtn.disabled = false;
                alert("❌ " + error.message);
                return;
            }
        }

        const resources = getResources();
        const index = resources.findIndex(r => String(r.id) === String(selectedResource.id));

        if (index === -1) {
            confirmBtn.disabled = false;
            alert("Resource not found in current listings.");
            window.location.href = "recipient_dashboard.html";
            return;
        }

        // Change status from Available -> Requested
        resources[index].status = "Requested";
        saveResources(resources);

        localStorage.removeItem("selectedResource");

        alert("🎉 Resource request submitted successfully! The donor has received your request.");
        window.location.href = "recipient_dashboard.html";
    });
}


/* ==========================================================================
   6. ADMIN CONTROLLER (admin_dashboard.html)
   ========================================================================== */

async function initLiveAdminDashboard() {
    const usersTableBody = document.getElementById("adminUsersTableBody");
    const resourcesTableBody = document.getElementById("adminResourcesTableBody");
    const requestsTableBody = document.getElementById("adminRequestsTableBody");
    if (usersTableBody) usersTableBody.innerHTML = `<tr><td colspan="5" class="loading-cell">Loading users...</td></tr>`;
    if (resourcesTableBody) resourcesTableBody.innerHTML = `<tr><td colspan="6" class="loading-cell">Loading resources...</td></tr>`;
    if (requestsTableBody) requestsTableBody.innerHTML = `<tr><td colspan="5" class="loading-cell">Loading requests...</td></tr>`;
    try {
        const [usersData, stats, resourcesData, requestsData] = await Promise.all([
            apiRequest("/admin/users"),
            apiRequest("/admin/stats"),
            apiRequest("/resources"),
            apiRequest("/requests")
        ]);
        const users = usersData.users || [];
        const resources = resourcesData.resources || [];
        const requests = requestsData.requests || [];
        adminResourceCache = new Map(resources.map(resource => [String(resource.id), resource]));

        document.getElementById("adminTotalUsers").textContent = stats.users.total;
        document.getElementById("adminTotalResources").textContent = stats.resources.total;
        document.getElementById("adminTotalRequests").textContent = stats.requests.pending + stats.requests.approved + stats.requests.handedOver;
        document.getElementById("adminTotalAllocated").textContent = stats.resources.completed;
        document.getElementById("adminUserCount").textContent = `${users.length} Users`;
        document.getElementById("adminRequestCount").textContent = `${requests.length} Requests`;

        if (usersTableBody) {
            usersTableBody.innerHTML = users.length ? users.map(user => `
                <tr>
                    <td><strong>${escapeHtml(user.firstName)} ${escapeHtml(user.lastName)}</strong></td>
                    <td>${escapeHtml(user.email)}</td>
                    <td><span class="role-badge ${(user.role || "user").toLowerCase()}">${escapeHtml(user.role)}</span></td>
                    <td><span class="status available">Active</span></td>
                    <td><button type="button" class="admin-btn-delete" onclick="adminDeleteUserApi('${user.id}')">Delete</button></td>
                </tr>
            `).join("") : `<tr><td colspan="5" class="empty-table-cell">No registered users in the network yet.</td></tr>`;
        }

        if (resourcesTableBody) {
            resourcesTableBody.innerHTML = resources.length ? resources.map(resource => `
                <tr>
                    <td><strong>${escapeHtml(resource.name)}</strong></td>
                    <td>${escapeHtml(resource.category || "Other")}</td>
                    <td>${escapeHtml(String(resource.quantity))}</td>
                    <td>${escapeHtml(resource.location || "Not specified")}</td>
                    <td><span class="status ${(resource.status || "").toLowerCase()}">${escapeHtml(resource.status)}</span></td>
                    <td><button type="button" class="table-btn" onclick="openDonorModalById('${resource.id}')">View</button><button type="button" class="admin-btn-delete" onclick="adminDeleteResourceApi('${resource.id}')">Remove</button></td>
                </tr>
            `).join("") : `<tr><td colspan="6" class="empty-table-cell">No resources currently listed in the database.</td></tr>`;
        }

        if (requestsTableBody) {
            requestsTableBody.innerHTML = requests.length ? requests.map(request => {
                const recipient = request.recipient || {};
                const resource = request.resource || {};
                return `
                    <tr>
                        <td><strong>${escapeHtml(resource.name || "Resource")}</strong></td>
                        <td>${escapeHtml(`${recipient.firstName || ""} ${recipient.lastName || ""}`.trim() || recipient.email || "Recipient")}</td>
                        <td>${escapeHtml(String(request.urgency || "-"))}</td>
                        <td>${escapeHtml(request.requestedAt ? new Date(request.requestedAt).toLocaleDateString() : "-")}</td>
                        <td><span class="status ${(request.status || "").toLowerCase()}">${escapeHtml(request.status)}</span></td>
                    </tr>
                `;
            }).join("") : `<tr><td colspan="5" class="empty-table-cell">No requests have been submitted yet.</td></tr>`;
        }
    } catch (error) {
        console.error("Unable to load live admin dashboard", error);
        if (usersTableBody) usersTableBody.innerHTML = `<tr><td colspan="5" class="empty-table-cell">Unable to load admin data. Please try again.</td></tr>`;
        if (resourcesTableBody) resourcesTableBody.innerHTML = `<tr><td colspan="6" class="empty-table-cell">Unable to load admin data. Please try again.</td></tr>`;
        if (requestsTableBody) requestsTableBody.innerHTML = `<tr><td colspan="5" class="empty-table-cell">Unable to load admin data. Please try again.</td></tr>`;
    }
}

async function adminDeleteUserApi(userId) {
    if (!confirm("Are you sure you want to remove this user?")) return;
    try {
        await apiRequest(`/admin/users/${userId}`, { method: "DELETE" });
        await initLiveAdminDashboard();
    } catch (error) {
        alert("❌ " + error.message);
    }
}

async function adminDeleteResourceApi(resourceId) {
    if (!confirm("Are you sure you want to remove this resource from the exchange?")) return;
    try {
        await apiRequest(`/resources/${resourceId}`, { method: "DELETE" });
        await initLiveAdminDashboard();
    } catch (error) {
        alert("❌ " + error.message);
    }
}

function initAdminDashboard() {
    const usersTableBody = document.getElementById("adminUsersTableBody");
    const resourcesTableBody = document.getElementById("adminResourcesTableBody");

    if (!usersTableBody && !resourcesTableBody) return;

    if (getAuthToken() && getCurrentUser()?.role === "ADMIN") {
        initLiveAdminDashboard();
        return;
    }

    const accounts = getAccounts();
    const resources = getResources();

    // Calculate metrics
    const totalUsers = accounts.length;
    const totalResources = resources.length;
    const totalRequests = resources.filter(r => (r.status || "").toLowerCase() === "requested").length;
    const totalAllocated = resources.filter(r => (r.status || "").toLowerCase() === "allocated").length;

    const usersCountEl = document.getElementById("adminTotalUsers");
    const resCountEl = document.getElementById("adminTotalResources");
    const reqCountEl = document.getElementById("adminTotalRequests");
    const allocCountEl = document.getElementById("adminTotalAllocated");
    const userBadgeEl = document.getElementById("adminUserCount");

    if (usersCountEl) usersCountEl.textContent = totalUsers;
    if (resCountEl) resCountEl.textContent = totalResources;
    if (reqCountEl) reqCountEl.textContent = totalRequests;
    if (allocCountEl) allocCountEl.textContent = totalAllocated;
    if (userBadgeEl) userBadgeEl.textContent = `${totalUsers} Users`;

    // Render User Management Table
    if (usersTableBody) {
        usersTableBody.innerHTML = "";

        if (accounts.length === 0) {
            usersTableBody.innerHTML = `
                <tr>
                    <td colspan="5" class="empty-table-cell">No registered users in the network yet.</td>
                </tr>
            `;
        } else {
            accounts.forEach(user => {
                const tr = document.createElement("tr");
                const roleClass = (user.role || "user").toLowerCase();

                tr.innerHTML = `
                    <td><strong>${escapeHtml(user.firstName)} ${escapeHtml(user.lastName)}</strong></td>
                    <td>${escapeHtml(user.email)}</td>
                    <td><span class="role-badge ${roleClass}">${escapeHtml(user.role)}</span></td>
                    <td><span class="status available">Active</span></td>
                    <td>
                        <div class="admin-actions">
                            <button
                                type="button"
                                class="admin-btn-delete"
                                onclick="adminDeleteUser('${user.email}')">
                                Delete
                            </button>
                        </div>
                    </td>
                `;
                usersTableBody.appendChild(tr);
            });
        }
    }

    // Render Resource Moderation Table
    if (resourcesTableBody) {
        resourcesTableBody.innerHTML = "";

        if (resources.length === 0) {
            resourcesTableBody.innerHTML = `
                <tr>
                    <td colspan="6" class="empty-table-cell">No resources currently listed in the database.</td>
                </tr>
            `;
        } else {
            resources.forEach(res => {
                const tr = document.createElement("tr");
                const statusClass = (res.status || "Available").toLowerCase();

                tr.innerHTML = `
                    <td><strong>${escapeHtml(res.name)}</strong></td>
                    <td>${escapeHtml(res.category || "Other")}</td>
                    <td>${escapeHtml(String(res.quantity))}</td>
                    <td>${escapeHtml(res.location || "Not specified")}</td>
                    <td>
                        <span class="status ${statusClass}">
                            ${escapeHtml(res.status || "Available")}
                        </span>
                    </td>
                    <td>
                        <div class="admin-actions">
                            <button
                                type="button"
                                class="table-btn"
                                onclick="openDonorModalById('${res.id}')">
                                View
                            </button>
                            <button
                                type="button"
                                class="admin-btn-delete"
                                onclick="adminDeleteResource('${res.id}')">
                                Remove
                            </button>
                        </div>
                    </td>
                `;
                resourcesTableBody.appendChild(tr);
            });
        }
    }
}

function adminDeleteUser(email) {
    if (!confirm(`Are you sure you want to remove user "${email}"?`)) return;

    let accounts = getAccounts();
    accounts = accounts.filter(acc => acc.email.toLowerCase() !== email.toLowerCase());
    saveAccounts(accounts);

    initAdminDashboard();
}

function adminDeleteResource(resourceId) {
    if (!confirm("Are you sure you want to remove this resource from the exchange?")) return;

    let resources = getResources();
    resources = resources.filter(res => String(res.id) !== String(resourceId));
    saveResources(resources);

    initAdminDashboard();
}


/* ==========================================================================
   7. GLOBAL INITIALIZATION
   ========================================================================== */

function initializeApp() {
    initAuth();
    document.querySelectorAll("a.logout").forEach(logoutLink => {
        logoutLink.addEventListener("click", function () {
            clearAuthSession();
        });
    });
    initDonorDashboard();
    initAddResource();
    initRecipientDashboard();
    initResourceDetails();
    initRequestConfirmation();
    initAdminDashboard();
}

// Run on DOM ready
if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", initializeApp);
} else {
    initializeApp();
}
