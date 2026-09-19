const swaggerDocument = {
  openapi: "3.0.0",
  info: {
    title: "Abros Healthcare API",
    version: "1.0.0",
    description:
      "Medicine Inventory Management System — medicines and customers API",
  },
  servers: [
    ...(process.env.RENDER_EXTERNAL_URL
      ? [{ url: process.env.RENDER_EXTERNAL_URL, description: "Production server" }]
      : []),
    {
      url: `http://localhost:${process.env.PORT || 3000}`,
      description: "Local server",
    },
  ],
  tags: [
    { name: "Medicines", description: "Medicine inventory operations" },
    { name: "Customers", description: "Customer management" },
  ],
  paths: {
    "/api/medicines": {
      post: {
        tags: ["Medicines"],
        summary: "Create a medicine",
        requestBody: {
          required: true,
          content: {
            "application/json": {
              schema: { $ref: "#/components/schemas/MedicineInput" },
            },
          },
        },
        responses: {
          201: { description: "Medicine created" },
          400: { description: "Validation error" },
        },
      },
      get: {
        tags: ["Medicines"],
        summary: "List medicines",
        parameters: [
          {
            name: "page",
            in: "query",
            schema: { type: "integer", default: 1 },
          },
          {
            name: "limit",
            in: "query",
            schema: { type: "integer", default: 10 },
          },
          {
            name: "sortBy",
            in: "query",
            schema: { type: "string", default: "createdAt" },
          },
          {
            name: "order",
            in: "query",
            schema: { type: "string", enum: ["asc", "desc"], default: "desc" },
          },
          { name: "name", in: "query", schema: { type: "string" } },
          { name: "packagingType", in: "query", schema: { type: "string" } },
          {
            name: "expired",
            in: "query",
            schema: { type: "string", enum: ["true", "false"] },
          },
        ],
        responses: { 200: { description: "Paginated medicine list" } },
      },
    },
    "/api/medicines/stats": {
      get: {
        tags: ["Medicines"],
        summary: "Inventory dashboard stats",
        parameters: [
          {
            name: "days",
            in: "query",
            schema: { type: "integer", default: 180 },
            description: "Days window for expiring-soon count",
          },
        ],
        responses: { 200: { description: "Inventory statistics" } },
      },
    },
    "/api/medicines/expiring-soon": {
      get: {
        tags: ["Medicines"],
        summary: "Medicines expiring soon",
        parameters: [
          {
            name: "days",
            in: "query",
            schema: { type: "integer", default: 180 },
          },
        ],
        responses: { 200: { description: "Expiring medicines list" } },
      },
    },
    "/api/medicines/expired": {
      get: {
        tags: ["Medicines"],
        summary: "Expired medicines",
        responses: { 200: { description: "Expired medicines list" } },
      },
    },
    "/api/medicines/{id}": {
      get: {
        tags: ["Medicines"],
        summary: "Get medicine by ID",
        parameters: [
          {
            name: "id",
            in: "path",
            required: true,
            schema: { type: "string" },
          },
        ],
        responses: {
          200: { description: "Medicine found" },
          404: { description: "Not found" },
        },
      },
      put: {
        tags: ["Medicines"],
        summary: "Update medicine",
        parameters: [
          {
            name: "id",
            in: "path",
            required: true,
            schema: { type: "string" },
          },
        ],
        requestBody: {
          content: {
            "application/json": {
              schema: { $ref: "#/components/schemas/MedicineInput" },
            },
          },
        },
        responses: {
          200: { description: "Medicine updated" },
          404: { description: "Not found" },
        },
      },
      delete: {
        tags: ["Medicines"],
        summary: "Delete medicine",
        parameters: [
          {
            name: "id",
            in: "path",
            required: true,
            schema: { type: "string" },
          },
        ],
        responses: {
          200: { description: "Medicine deleted" },
          404: { description: "Not found" },
        },
      },
    },
    "/api/customers": {
      post: {
        tags: ["Customers"],
        summary: "Create a customer",
        requestBody: {
          required: true,
          content: {
            "application/json": {
              schema: { $ref: "#/components/schemas/CustomerInput" },
            },
          },
        },
        responses: {
          201: { description: "Customer created" },
          400: { description: "Validation or duplicate error" },
        },
      },
      get: {
        tags: ["Customers"],
        summary: "List customers",
        parameters: [
          {
            name: "page",
            in: "query",
            schema: { type: "integer", default: 1 },
          },
          {
            name: "limit",
            in: "query",
            schema: { type: "integer", default: 10 },
          },
          {
            name: "sortBy",
            in: "query",
            schema: { type: "string", default: "createdAt" },
          },
          {
            name: "order",
            in: "query",
            schema: { type: "string", enum: ["asc", "desc"], default: "desc" },
          },
          { name: "name", in: "query", schema: { type: "string" } },
          { name: "contact", in: "query", schema: { type: "string" } },
          { name: "dlNo", in: "query", schema: { type: "string" } },
          { name: "gstin", in: "query", schema: { type: "string" } },
        ],
        responses: { 200: { description: "Paginated customer list" } },
      },
    },
    "/api/customers/stats": {
      get: {
        tags: ["Customers"],
        summary: "Customer statistics",
        responses: { 200: { description: "Customer stats" } },
      },
    },
    "/api/customers/dl/{dlNo}": {
      get: {
        tags: ["Customers"],
        summary: "Get customer by DL number",
        parameters: [
          {
            name: "dlNo",
            in: "path",
            required: true,
            schema: { type: "string" },
          },
        ],
        responses: {
          200: { description: "Customer found" },
          404: { description: "Not found" },
        },
      },
    },
    "/api/customers/{id}": {
      get: {
        tags: ["Customers"],
        summary: "Get customer by ID",
        parameters: [
          {
            name: "id",
            in: "path",
            required: true,
            schema: { type: "string" },
          },
        ],
        responses: {
          200: { description: "Customer found" },
          404: { description: "Not found" },
        },
      },
      put: {
        tags: ["Customers"],
        summary: "Update customer",
        parameters: [
          {
            name: "id",
            in: "path",
            required: true,
            schema: { type: "string" },
          },
        ],
        requestBody: {
          content: {
            "application/json": {
              schema: { $ref: "#/components/schemas/CustomerInput" },
            },
          },
        },
        responses: {
          200: { description: "Customer updated" },
          404: { description: "Not found" },
        },
      },
      delete: {
        tags: ["Customers"],
        summary: "Delete customer",
        parameters: [
          {
            name: "id",
            in: "path",
            required: true,
            schema: { type: "string" },
          },
        ],
        responses: {
          200: { description: "Customer deleted" },
          404: { description: "Not found" },
        },
      },
    },
  },
  components: {
    schemas: {
      MedicineInput: {
        type: "object",
        required: ["name", "expiryDate", "packagingType", "mrp"],
        properties: {
          name: { type: "string", example: "Paracetamol 500mg" },
          expiryDate: {
            type: "string",
            format: "date-time",
            example: "2027-12-31T00:00:00.000Z",
          },
          packagingType: { type: "string", example: "Strip" },
          mrp: { type: "number", example: 25.5 },
          quantity: { type: "number", example: 100 },
          batchNumber: { type: "string", example: "BATCH-001" },
          manufacturer: { type: "string", example: "Abros Pharma" },
          hsn: { type: "string", example: "3004" },
          description: { type: "string", example: "Pain relief tablet" },
        },
      },
      CustomerInput: {
        type: "object",
        required: ["name", "address"],
        properties: {
          name: { type: "string", example: "City Medical Store" },
          address: { type: "string", example: "123 Main Street, Delhi" },
          contact: { type: "string", example: "9876543210" },
          gstin: { type: "string", example: "07AABCU9603R1ZM" },
          dlNo: { type: "string", example: "DL-123456" },
        },
      },
    },
  },
};

module.exports = swaggerDocument;
